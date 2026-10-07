import { CompanionModeId, Memory, MemorySource, UserProfile } from '../../types';
import { TalkIntent } from '../ai/companion-intent';
import { resolveMemoryPolicy } from '../ai/turn-intelligence-plan';
import { IMemoryRepository } from '../contracts';
import { ExtractedMemoryCandidate, IAIService } from '../contracts';
import {
  looksLikeReschedule,
  mergeMemoryContent,
  mergeTags,
  resolveImportance,
} from './memory-deduplication';
import { extractMemoriesLocally } from './local-memory-extractor';
import {
  MemoryRetrievalContext,
  filterMemoriesForIntent,
  overlapScore,
  rankMemories,
  tokenize,
  TOP_MEMORY_LIMIT,
} from './memory-relevance';
import { memoryAgingEngine } from '../personality/memory-aging-engine';
import { nowIso } from '../../types';
import {
  assessMemoryWrite,
  decisionToCandidate,
  enrichCandidateDecision,
} from './memory-write-policy';
import {
  buildSupersededPatch,
  findSupersessionTargets,
  shouldReplaceInsteadOfMerge,
} from './memory-supersession';
import { importanceFromLevel, TAG_SUPERSEDED } from './memory-taxonomy';
import { logMemoryRetrieveDiagnostic, logMemoryWriteDiagnostic } from './memory-diagnostics';
import {
  executeUserMemoryCommand,
  parseUserMemoryCommand,
} from './memory-user-commands';
import {
  countTemporalAlignments,
  decideMemoryCallback,
  memoryTemporallyAligns,
} from './memory-callback-gate';
import {
  applyOpenLoopLifecycle,
  joinOpenLoops,
  keepOpenLoopTagsOnUpdate,
} from './open-loop-service';
import { parseUserTemporal, readTemporalMeta } from './temporal-memory';
import { resolveDeviceTimeZone } from './temporal-parse';

export type ProcessConversationInput = {
  userId: string;
  userMessage: string;
  voxaReply: string;
  mode: CompanionModeId;
  userProfile: UserProfile;
  mediaSource?: MemorySource;
};

/**
 * Retrieves relevant memories for prompts and extracts new ones after each exchange.
 */
export class MemoryIntelligenceService {
  constructor(
    private readonly memories: IMemoryRepository,
    private readonly ai: IAIService,
  ) {}

  async handleUserMemoryCommand(userId: string, userMessage: string): Promise<void> {
    const command = parseUserMemoryCommand(userMessage);
    if (!command) return;
    await executeUserMemoryCommand(this.memories, userId, command);
  }

  async retrieveForPrompt(
    userId: string,
    context: MemoryRetrievalContext,
    options?: { intent?: TalkIntent },
  ): Promise<Memory[]> {
    const allMemories = await this.memories.listMemories(userId);
    const activeMemories = memoryAgingEngine.filterActive(allMemories);
    if (activeMemories.length === 0) return [];

    const intent = options?.intent;
    const memoryPolicy = context.memoryPolicy ?? (intent ? resolveMemoryPolicy(intent) : 'recall');
    if (memoryPolicy === 'skip') {
      logMemoryRetrieveDiagnostic({
        intent: intent ?? 'unknown',
        candidates: allMemories.length,
        active: activeMemories.length,
        selected: [],
      });
      return [];
    }

    const retrievalContext = { ...context, memoryPolicy };
    const ranked = rankMemories(activeMemories, retrievalContext, TOP_MEMORY_LIMIT);
    const timeZone = resolveDeviceTimeZone(context.timeZone);
    const now = context.now ?? new Date();
    const queryTemporal = parseUserTemporal(context.userMessage, now, timeZone);
    const selectedBase = intent
      ? filterMemoriesForIntent(ranked, intent, context.userMessage, memoryPolicy)
      : ranked.map((item) => item.memory);
    const join = joinOpenLoops(activeMemories, {
      userMessage: context.userMessage,
      now,
      timeZone,
      recentMessageTexts: context.recentMessageTexts,
    });
    const selected =
      join.unique && join.memory && !selectedBase.some((memory) => memory.id === join.memory!.id)
        ? [join.memory, ...selectedBase]
        : selectedBase;
    const alignCount = join.ambiguous
      ? join.competing.length
      : countTemporalAlignments(selected, queryTemporal, timeZone);
    const gated = selected.filter((memory) => {
      const recentOverlap = overlapScore(
        tokenize([context.userMessage, ...(context.recentMessageTexts ?? [])].join(' ')),
        `${memory.title} ${memory.content}`,
      );
      const keywordOverlap = Math.max(
        overlapScore(tokenize(context.userMessage), `${memory.title} ${memory.content}`),
        recentOverlap * 0.5,
      );
      const action = decideMemoryCallback({
        memory,
        userMessage: context.userMessage,
        intent,
        memoryPolicy,
        now,
        timeZone,
        queryTemporal,
        keywordOverlap,
        temporalAlign: memoryTemporallyAligns(memory, queryTemporal, timeZone),
        ambiguousTemporalMatch: join.ambiguous || Boolean(queryTemporal && alignCount > 1 && keywordOverlap < 0.2),
        uniqueOpenLoop: join.unique && join.memory?.id === memory.id,
      });
      return action !== 'ignore';
    });

    logMemoryRetrieveDiagnostic({
      intent: intent ?? 'unknown',
      candidates: allMemories.length,
      active: activeMemories.length,
      selected: gated,
    });

    if (gated.length === 0) return [];

    const timestamp = nowIso();

    const touched = await Promise.all(
      gated.map(async (memory) => {
        try {
          return await this.memories.updateMemory(memory.id, {
            lastUsedAt: timestamp,
            useCount: (memory.useCount ?? 0) + 1,
            ...memoryAgingEngine.enrichOnUpdate(memory, {
              useCount: (memory.useCount ?? 0) + 1,
            }),
          });
        } catch {
          return memory;
        }
      }),
    );

    return touched;
  }

  async processAfterReply(input: ProcessConversationInput): Promise<Memory[]> {
    if (!input.userProfile.preferences.memoryEnabled) return [];

    const existing = await this.memories.listMemories(input.userId);
    const writeContext = {
      now: new Date(),
      timeZone: resolveDeviceTimeZone(input.userProfile.timezone),
    };

    const lifecycle = applyOpenLoopLifecycle(existing, input.userMessage, writeContext);
    if (lifecycle.target && lifecycle.patch) {
      const updated = await this.memories.updateMemory(lifecycle.target.id, lifecycle.patch);
      if (lifecycle.suppressExtract) return [updated];
    }

    let candidates: ExtractedMemoryCandidate[] = [];

    try {
      candidates = await this.ai.extractMemoriesFromExchange({
        userMessage: input.userMessage,
        voxaReply: input.voxaReply,
        mode: input.mode,
        userProfile: input.userProfile,
        existingMemories: existing,
        mediaSource: input.mediaSource,
      });
    } catch (error) {
      console.warn('[Voxa] Memory extraction failed, using local rules.', error);
      candidates = extractMemoriesLocally({
        userMessage: input.userMessage,
        voxaReply: input.voxaReply,
        mode: input.mode,
        existingMemories: existing,
        writeContext,
      });
    }

    if (candidates.length === 0) {
      candidates = extractMemoriesLocally({
        userMessage: input.userMessage,
        voxaReply: input.voxaReply,
        mode: input.mode,
        existingMemories: existing,
        writeContext,
      });
    }

    const policyWrite = assessMemoryWrite(input.userMessage, writeContext);
    if (policyWrite?.shouldPersist) {
      const fromPolicy = decisionToCandidate(policyWrite);
      const already = candidates.some(
        (item) => item.content.trim().toLowerCase() === fromPolicy.content.trim().toLowerCase(),
      );
      if (!already) candidates = [fromPolicy, ...candidates];
    }

    const upserted: Memory[] = [];
    const workingSet = [...existing];

    for (const candidate of candidates) {
      const decision = enrichCandidateDecision(candidate, input.userMessage, writeContext);
      if (!decision.shouldPersist) {
        logMemoryWriteDiagnostic({ action: 'skip', decision });
        continue;
      }

      const { target, supersedeIds } = findSupersessionTargets(workingSet, decision);

      for (const supersedeId of supersedeIds) {
        const old = workingSet.find((item) => item.id === supersedeId);
        if (!old) continue;
        const superseded = await this.memories.updateMemory(supersedeId, buildSupersededPatch(old));
        const index = workingSet.findIndex((item) => item.id === supersedeId);
        if (index >= 0) workingSet[index] = superseded;
        logMemoryWriteDiagnostic({ action: 'supersede', decision });
      }

      if (target && shouldReplaceInsteadOfMerge(decision, target)) {
        const content = looksLikeReschedule(decision.content)
          ? appendEarlierTemporal(target, decision.content, writeContext.timeZone)
          : decision.content;
        const updated = await this.memories.updateMemory(target.id, {
          title: decision.title.length >= target.title.length ? decision.title : target.title,
          content,
          importance: importanceFromLevel(decision.importance),
          mood: candidate.mood ?? target.mood,
          tags: keepOpenLoopTagsOnUpdate(
            target.tags.filter((tag) => tag !== TAG_SUPERSEDED),
            decision.tags,
          ),
          confidence: decision.confidenceScore,
          expiresAt: decision.expiresAt ?? target.expiresAt,
          occurredAt: decision.occurredAt ?? target.occurredAt,
          relatedMode: candidate.relatedMode ?? target.relatedMode,
        });
        const index = workingSet.findIndex((item) => item.id === target.id);
        if (index >= 0) workingSet[index] = updated;
        upserted.push(updated);
        logMemoryWriteDiagnostic({ action: 'update', decision });
        continue;
      }

      if (target) {
        const updated = await this.memories.updateMemory(target.id, {
          title: candidate.title.length >= target.title.length ? candidate.title : target.title,
          content: mergeMemoryContent(target.content, candidate.content),
          importance: resolveImportance(target.importance, importanceFromLevel(decision.importance)),
          mood: candidate.mood ?? target.mood,
          tags: mergeTags(target.tags, decision.tags),
          confidence: Math.max(target.confidence ?? 0.7, decision.confidenceScore),
          expiresAt: decision.expiresAt ?? target.expiresAt,
          occurredAt: decision.occurredAt ?? target.occurredAt,
        });
        const index = workingSet.findIndex((item) => item.id === target.id);
        if (index >= 0) workingSet[index] = updated;
        upserted.push(updated);
        logMemoryWriteDiagnostic({ action: 'update', decision });
        continue;
      }

      const enrichedCandidate = decisionToCandidate(decision);
      const created = await this.memories.createMemory(
        memoryAgingEngine.enrichOnCreate({
          userId: input.userId,
          category: enrichedCandidate.category,
          title: enrichedCandidate.title,
          content: enrichedCandidate.content,
          mood: enrichedCandidate.mood ?? candidate.mood,
          importance: enrichedCandidate.importance,
          tags: enrichedCandidate.tags,
          relatedMode: candidate.relatedMode ?? input.mode,
          source: resolveMemorySource(input.mediaSource),
          confidence: enrichedCandidate.confidence,
          expiresAt: enrichedCandidate.expiresAt,
          occurredAt: enrichedCandidate.occurredAt,
        }),
      );
      workingSet.unshift(created);
      upserted.push(created);
      logMemoryWriteDiagnostic({ action: 'create', decision });
    }

    return upserted;
  }
}

function resolveMemorySource(mediaSource?: MemorySource): MemorySource {
  if (mediaSource && mediaSource !== 'text' && mediaSource !== 'conversation') {
    return mediaSource;
  }
  return 'conversation';
}

function appendEarlierTemporal(existing: Memory, incoming: string, timeZone: string): string {
  const meta = readTemporalMeta(existing, timeZone);
  if (!meta.label || incoming.toLowerCase().includes('earlier:')) return incoming;
  return `${incoming.trim()} (earlier: ${meta.label})`;
}
