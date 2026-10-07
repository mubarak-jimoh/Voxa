import { MEMORY_MODE_AFFINITY } from '../../constants/memory-categories';
import { CompanionModeId, Memory } from '../../types';
import { TalkIntent } from '../ai/companion-intent';
import { MemoryPolicy } from '../ai/turn-intelligence-plan';
import { inferMemoryTheme, themeOverlapScore } from './memory-theme-service';
import { memoryAgingEngine } from '../personality/memory-aging-engine';
import { isSupersededMemory, memoryConfidenceKind, memoryTags, TAG_EXPLICIT } from './memory-taxonomy';
import { isActiveOpenLoop, isCancelledMemory, isResolvedMemory, joinOpenLoops } from './open-loop-service';
import { parseUserTemporal, readTemporalMeta } from './temporal-memory';
import { ParsedTemporal, resolveDeviceTimeZone, sameLocalDay } from './temporal-parse';

export type MemoryRetrievalContext = {
  userMessage: string;
  mode: CompanionModeId;
  recentMessageTexts?: string[];
  memoryLevel?: 'minimal' | 'balanced' | 'deep';
  now?: Date;
  timeZone?: string;
  memoryPolicy?: MemoryPolicy;
};

export type ScoredMemory = {
  memory: Memory;
  score: number;
};

const MEMORY_LEVEL_LIMIT: Record<'minimal' | 'balanced' | 'deep', number> = {
  minimal: 3,
  balanced: 5,
  deep: 8,
};

function isExpired(memory: Memory, now = Date.now()): boolean {
  if (!memory.expiresAt) return false;
  return new Date(memory.expiresAt).getTime() < now;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'i',
  'me',
  'my',
  'we',
  'you',
  'your',
  'is',
  'are',
  'was',
  'were',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'it',
  'that',
  'this',
  'with',
  'have',
  'has',
  'had',
  'be',
  'been',
  'do',
  'does',
  'did',
  'am',
  'so',
  'just',
  'about',
  'like',
  'really',
  'very',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function tokensOverlap(queryToken: string, targetToken: string): boolean {
  if (queryToken === targetToken) return true;
  if (queryToken.length >= 4 && targetToken.length >= 4) {
    return queryToken.startsWith(targetToken) || targetToken.startsWith(queryToken);
  }
  return false;
}

export function overlapScore(queryTokens: Set<string>, targetText: string): number {
  const targetTokens = tokenize(targetText);
  if (queryTokens.size === 0 || targetTokens.size === 0) return 0;

  let matches = 0;
  for (const token of queryTokens) {
    for (const target of targetTokens) {
      if (tokensOverlap(token, target)) {
        matches += 1;
        break;
      }
    }
  }

  return matches / Math.max(queryTokens.size, 1);
}

function recencyScore(isoDate: string, now = Date.now()): number {
  const ageMs = now - new Date(isoDate).getTime();
  const days = ageMs / (1000 * 60 * 60 * 24);
  if (days <= 1) return 1;
  if (days <= 7) return 0.75;
  if (days <= 30) return 0.5;
  if (days <= 90) return 0.25;
  return 0.1;
}

function usageScore(memory: Memory, now = Date.now()): number {
  const useCount = memory.useCount ?? 0;
  const useBoost = Math.min(useCount / 10, 0.4);
  const lastUsedBoost = memory.lastUsedAt ? recencyScore(memory.lastUsedAt, now) * 0.35 : 0;
  return useBoost + lastUsedBoost;
}

function modeAffinityScore(memory: Memory, mode: CompanionModeId): number {
  const affinityModes = MEMORY_MODE_AFFINITY[memory.category] ?? [];
  if (affinityModes.includes(mode)) return 1;
  if (memory.relatedMode === mode) return 0.85;
  return 0.2;
}

export function temporalAlignmentScore(
  memory: Memory,
  queryTemporal: ParsedTemporal | null,
  timeZone: string,
): number {
  if (!queryTemporal || !memory.occurredAt) return 0;
  if (sameLocalDay(memory.occurredAt, queryTemporal.occurredAt, timeZone)) return 5;
  const delta = Math.abs(new Date(memory.occurredAt).getTime() - new Date(queryTemporal.occurredAt).getTime());
  if (delta <= 36 * 60 * 60 * 1000) return 2;
  return 0;
}

export function scoreMemoryRelevance(memory: Memory, context: MemoryRetrievalContext): number {
  const now = context.now?.getTime() ?? Date.now();
  if (isExpired(memory, now) || isSupersededMemory(memory)) return -1;

  const timeZone = resolveDeviceTimeZone(context.timeZone);
  const queryTemporal = parseUserTemporal(context.userMessage, context.now ?? new Date(), timeZone);
  const cancelledOrResolved = isCancelledMemory(memory) || isResolvedMemory(memory);
  const temporalBoost =
    cancelledOrResolved ? 0 : temporalAlignmentScore(memory, queryTemporal, timeZone);
  const meta = readTemporalMeta(memory, timeZone);

  const tags = memoryTags(memory);
  const pinnedBoost = memory.pinned === true || tags.includes('pinned') ? 6 : 0;
  const explicitBoost = tags.includes(TAG_EXPLICIT) ? 2.5 : 0;
  const confidenceKind = memoryConfidenceKind(memory);
  const inferredPenalty = confidenceKind === 'inferred' ? -1.25 : 0;

  const queryText = [context.userMessage, ...(context.recentMessageTexts ?? [])].join(' ');
  const queryTokens = tokenize(queryText);
  const searchable = `${memory.title} ${memory.content} ${tags.join(' ')}`;

  const keywordScore = overlapScore(queryTokens, searchable);
  const importanceScore = memory.importance / 5;
  const emotionalScore = (memory.emotionalSignificance ?? memory.importance) / 5;
  const confidenceScore = memory.confidence ?? 0.75;
  const recency = recencyScore(memory.updatedAt, now);
  const usage = usageScore(memory, now);
  const modeAffinity = modeAffinityScore(memory, context.mode);
  const theme = inferMemoryTheme(memory);
  const semanticThemeScore = themeOverlapScore(queryText, theme) * 2.5;
  const longTermBoost = memoryAgingEngine.longTermRank(memory, context.now ?? new Date()) * 2;
  const openLoopBoost =
    !cancelledOrResolved && isActiveOpenLoop(memory, context.now) && temporalBoost >= 5 ? 2 : 0;
  const topical = keywordScore * 4 + semanticThemeScore + temporalBoost + openLoopBoost;

  if (topical < 0.45 && pinnedBoost === 0 && temporalBoost < 5) return -1;
  if (meta.temporalConfidence === 'low' && keywordScore < 0.35) return -1;

  return (
    pinnedBoost +
    explicitBoost +
    inferredPenalty +
    keywordScore * 4 +
    semanticThemeScore +
    temporalBoost +
    openLoopBoost +
    importanceScore * 1.5 +
    emotionalScore * 1.25 +
    confidenceScore * 0.75 +
    recency * 1 +
    usage * 1.25 +
    modeAffinity * 1.5 +
    longTermBoost
  );
}

export function rankMemories(
  memories: Memory[],
  context: MemoryRetrievalContext,
  limit = TOP_MEMORY_LIMIT,
): ScoredMemory[] {
  const effectiveLimit = MEMORY_LEVEL_LIMIT[context.memoryLevel ?? 'balanced'] ?? limit;
  const now = context.now?.getTime() ?? Date.now();
  const join = joinOpenLoops(memories, {
    userMessage: context.userMessage,
    now: context.now,
    timeZone: context.timeZone,
    recentMessageTexts: context.recentMessageTexts,
  });

  return memories
    .filter((memory) => !isExpired(memory, now) && !isSupersededMemory(memory))
    .map((memory) => {
      let score = scoreMemoryRelevance(memory, context);
      if (join.unique && join.memory?.id === memory.id && score >= 0) {
        score += 4;
      }
      if (join.ambiguous && join.competing.some((item) => item.id === memory.id)) {
        score = Math.min(score, 1);
      }
      return { memory, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, effectiveLimit);
}

const MIN_SCORE_BY_INTENT: Partial<Record<TalkIntent, number>> = {
  factual_question: 4,
  casual_conversation: 2.75,
  celebration: 2.5,
  app_action_request: 999,
};

export function filterMemoriesForIntent(
  scored: ScoredMemory[],
  intent: TalkIntent,
  userMessage?: string,
  memoryPolicy?: MemoryPolicy,
): Memory[] {
  if (scored.length === 0) return [];
  if (memoryPolicy === 'skip' || intent === 'factual_question' || intent === 'app_action_request') {
    return [];
  }
  if (intent === 'memory_recall') {
    return scored.filter((item) => item.score >= 0.45).map((item) => item.memory);
  }

  const topScore = scored[0]?.score ?? 0;
  const minScore = MIN_SCORE_BY_INTENT[intent] ?? 2;
  const relativeFloor = topScore > 0 ? topScore * 0.55 : minScore;
  const threshold = Math.max(minScore, relativeFloor);
  let filtered = scored.filter((item) => item.score >= threshold);

  if (
    userMessage &&
    ['decision_support', 'planning', 'goal_progress', 'productivity', 'routine'].includes(intent)
  ) {
    const keywordHits = filtered.filter(
      (item) => overlapScore(tokenize(userMessage), `${item.memory.title} ${item.memory.content}`) > 0,
    );
    if (keywordHits.length > 0) {
      filtered = keywordHits;
    } else {
      filtered = [];
    }
  }

  if (memoryPolicy === 'high_confidence_only') {
    filtered = filtered.filter((item) => {
      const high = (item.memory.confidence ?? 0) >= 0.8 || item.memory.tags.includes(TAG_EXPLICIT);
      const meta = readTemporalMeta(item.memory);
      return high && meta.temporalConfidence !== 'low' && meta.precision !== 'vague';
    });
  }

  if (filtered.length > 0) {
    return filtered.map((item) => item.memory);
  }

  return [];
}

const TOP_MEMORY_LIMIT = 5;

export { TOP_MEMORY_LIMIT };
