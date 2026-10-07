import { MemoryCategory } from '../../types';
import { ExtractedMemoryCandidate } from '../contracts';
import {
  MemoryConfidenceKind,
  MemoryImportanceLevel,
  MemorySemanticSlot,
  TAG_EXPLICIT,
  TAG_INFERRED,
  TAG_OPEN_LOOP,
  TRANSIENT_IMPORTANCE_THRESHOLD,
  inferSemanticSlot,
  importanceFromLevel,
} from './memory-taxonomy';
import { classifyLiveInformationNeed } from '../ai/live-information';
import { isDurableEnoughToStore } from './memory-quality';
import { TAG_SENSITIVE, detectMemorySensitivity, shouldPersistSensitiveFact } from './memory-sensitivity';
import { isOpenLoopEligible } from './open-loop-service';
import { mergeTemporalTags, parseUserTemporal } from './temporal-memory';
import { TemporalParseContext, resolveDeviceTimeZone } from './temporal-parse';

export type MemoryWriteContext = Partial<TemporalParseContext>;

export type MemoryWriteDecision = {
  shouldPersist: boolean;
  importance: MemoryImportanceLevel;
  confidenceKind: MemoryConfidenceKind;
  confidenceScore: number;
  expiresAt?: string;
  occurredAt?: string;
  tags: string[];
  semanticSlot: MemorySemanticSlot;
  title: string;
  category: MemoryCategory;
  content: string;
  reason: string;
};

const TRANSIENT_PATTERNS = [
  /^(lol|lmao|haha|jk|just kidding)\b/i,
  /^(yeah|yep|ok|okay|thanks|thank you|cool|nice|sure)\b/i,
  /\b(right now|at the moment|currently eating|just ate)\b/i,
];

const SHORT_HEDGE = /\b(maybe|probably|might|perhaps|whatever|nevermind|never mind)\b/i;

const EXPLICIT_REMEMBER = /\b(remember that|remember this|don't forget|do not forget)\b/i;
const EXPLICIT_CORRECTION = /\b(that's wrong|that is wrong|actually|i don't anymore|anymore|not anymore|from now on|i switched|i've switched|i have switched|i stopped|i've stopped|i hate|i don't like)\b/i;
const EXPLICIT_CONVERSATIONAL_STYLE =
  /\b(keep your (replies|answers) short|be more direct with me|be more direct|don't ask me loads of questions|don't ask so many questions|i like detailed explanations|be honest and just pick|you can joke with me)\b/i;

const EXPLICIT_PREFERENCE = /\b(i prefer|i like|i love|i usually|i always|my goal is|i'm trying to|i am trying to|i'm working on|i am working on|i'm studying|i study (?!later|tonight|tomorrow|now|this|harder|more)|i'm applying for|my interview is|my exam is|i box|times a week|i'm building|i am building|i support |my lucky number|my (?:favourite|favorite)|my (?:dog|cat|pet)'s name)\b/i;

const RECALL_QUESTION =
  /^(what(?:'s| is| was)|who(?:'s| is)|where(?:'s| is)|when(?:'s| is)|why|how|did i|do you remember)\b/i;

const THIRD_PERSON_FACT =
  /\b((?:my )?(?:friend|mate|sister|brother|mum|mom|dad|partner|colleague)'s|his|her|their)\s+(lucky number|favourite|favorite|dog|cat)\b/i;

const EXPLICIT_EVENT =
  /\b(driving test|i'?ve got (my|a|an) (driving test|interview|exam|test|deadline|meeting|appointment)|my test is|interview is|exam is|deadline is|they moved|rescheduled|postponed|waiting to hear|trying to finish|need to decide whether|accept the offer|meeting \w+ tomorrow)\b/i;

const EVENT_TEMPORAL = /\b(tomorrow|today|tonight|this week|next week|this weekend|on friday|on monday|due tomorrow|interview is|exam is|deadline|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i;

export function assessMemoryWrite(
  userMessage: string,
  writeContext?: MemoryWriteContext,
): MemoryWriteDecision | null {
  const text = userMessage.trim();
  if (text.length < 8) return null;

  const lower = text.toLowerCase();
  const ctx = normalizeWriteContext(writeContext);
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(lower)) && !EXPLICIT_REMEMBER.test(lower)) {
    return null;
  }
  if (SHORT_HEDGE.test(lower) && text.length < 40 && !EXPLICIT_EVENT.test(lower) && !EXPLICIT_REMEMBER.test(lower)) {
    return null;
  }
  if (!isDurableEnoughToStore(text) && !EXPLICIT_REMEMBER.test(lower)) {
    return null;
  }

  const explicitRemember = EXPLICIT_REMEMBER.test(lower);
  if (!explicitRemember && (/\?/.test(text) || RECALL_QUESTION.test(lower))) return null;
  if (!explicitRemember && THIRD_PERSON_FACT.test(lower)) return null;
  if (!explicitRemember && classifyLiveInformationNeed(text) !== 'none') return null;
  if (!explicitRemember && /^\s*\[photo/i.test(text)) return null;
  if (!shouldPersistSensitiveFact(text, explicitRemember)) {
    return null;
  }

  if (explicitRemember) {
    const content = text.replace(/remember (that|this)/i, '').replace(/don't forget/i, '').trim();
    return buildDecision({
      content: content || text,
      title: 'User asked to remember',
      category: 'moments',
      importance: 4,
      confidenceKind: 'explicit',
      tags: sensitiveTags(text, [TAG_EXPLICIT]),
      reason: 'explicit_remember_request',
      ctx,
    });
  }

  if (EXPLICIT_CONVERSATIONAL_STYLE.test(lower) || (/\bfrom now on\b/i.test(lower) && /\b(short|direct|question|joke|detail|replies|answers)\b/i.test(lower))) {
    return buildDecision({
      content: text,
      title: 'Conversation style preference',
      category: 'preferences',
      importance: 4,
      confidenceKind: 'explicit',
      tags: [TAG_EXPLICIT, 'conversational_preference'],
      reason: 'explicit_conversational_preference',
      ctx,
    });
  }

  if (EXPLICIT_CORRECTION.test(lower) || /\b(moved|reschedul|postponed)\b/i.test(lower)) {
    const category = inferCategoryFromText(lower);
    return buildDecision({
      content: text,
      title: inferTitleFromText(lower, category),
      category,
      importance: 4,
      confidenceKind: 'explicit',
      tags: [TAG_EXPLICIT],
      reason: 'explicit_correction',
      ctx,
    });
  }

  if (EXPLICIT_PREFERENCE.test(lower) || EXPLICIT_EVENT.test(lower)) {
    const category = inferCategoryFromText(lower);
    const importance: MemoryImportanceLevel =
      /\bmy goal is|working on|trying to|applying for|building\b/.test(lower) ? 4 : 3;
    return buildDecision({
      content: text,
      title: inferTitleFromText(lower, category),
      category,
      importance,
      confidenceKind: 'explicit',
      tags: [TAG_EXPLICIT],
      reason: 'explicit_statement',
      temporal: EVENT_TEMPORAL.test(lower) || EXPLICIT_EVENT.test(lower),
      ctx,
    });
  }

  return null;
}

export function enrichCandidateDecision(
  candidate: ExtractedMemoryCandidate,
  userMessage: string,
  writeContext?: MemoryWriteContext,
): MemoryWriteDecision {
  const ctx = normalizeWriteContext(writeContext);
  const explicit = assessMemoryWrite(userMessage, ctx);
  const importance = Math.max(
    explicit?.importance ?? 0,
    candidate.importance ?? 2,
  ) as MemoryImportanceLevel;

  if (!isDurableEnoughToStore(userMessage) && !explicit) {
    return skipDecision(candidate, 'ephemeral_chatter', importance);
  }

  if (!shouldPersistSensitiveFact(userMessage, Boolean(explicit && explicit.reason === 'explicit_remember_request'))) {
    return skipDecision(candidate, 'sensitive_without_explicit_remember', importance);
  }

  if (importance <= TRANSIENT_IMPORTANCE_THRESHOLD) {
    return skipDecision(candidate, 'importance_too_low', importance);
  }

  const confidenceKind: MemoryConfidenceKind = explicit ? 'explicit' : 'high';
  const parsed = explicit?.occurredAt
    ? parseUserTemporal(userMessage, ctx.now, ctx.timeZone)
    : parseUserTemporal(candidate.content, ctx.now, ctx.timeZone) ??
      parseUserTemporal(userMessage, ctx.now, ctx.timeZone);

  let confidenceScore = confidenceKind === 'explicit' ? 0.92 : 0.78;
  if (parsed?.temporalConfidence === 'medium') confidenceScore = Math.min(confidenceScore, 0.7);
  if (parsed?.temporalConfidence === 'low') confidenceScore = Math.min(confidenceScore, 0.52);
  if (/\b(i think|probably)\b/i.test(userMessage)) confidenceScore = Math.min(confidenceScore, 0.68);
  if (/\b(maybe|might|sometime)\b/i.test(userMessage)) confidenceScore = Math.min(confidenceScore, 0.48);

  const tags = mergeTemporalTags(
    mergeTags(
      mergeTags(candidate.tags, sensitiveTags(userMessage, explicit?.tags ?? [TAG_EXPLICIT])),
      isOpenLoopEligible(userMessage) || isOpenLoopEligible(candidate.content) ? [TAG_OPEN_LOOP] : [],
    ),
    parsed,
  );

  return {
    shouldPersist: true,
    importance,
    confidenceKind,
    confidenceScore,
    expiresAt: parsed?.expiresAt ?? explicit?.expiresAt ?? resolveExpiry(candidate.category, candidate.content, ctx),
    occurredAt: parsed?.occurredAt,
    tags,
    semanticSlot: inferSemanticSlot(candidate.category, candidate.content),
    title: candidate.title,
    category: candidate.category,
    content: candidate.content,
    reason: explicit ? 'explicit_enriched_candidate' : 'rule_candidate',
  };
}

function skipDecision(
  candidate: ExtractedMemoryCandidate,
  reason: string,
  importance: MemoryImportanceLevel,
): MemoryWriteDecision {
  return {
    shouldPersist: false,
    importance,
    confidenceKind: 'inferred',
    confidenceScore: 0.45,
    tags: [TAG_INFERRED],
    semanticSlot: inferSemanticSlot(candidate.category, candidate.content),
    title: candidate.title,
    category: candidate.category,
    content: candidate.content,
    reason,
  };
}

function buildDecision(input: {
  content: string;
  title: string;
  category: MemoryCategory;
  importance: MemoryImportanceLevel;
  confidenceKind: MemoryConfidenceKind;
  tags: string[];
  reason: string;
  temporal?: boolean;
  ctx: TemporalParseContext;
}): MemoryWriteDecision {
  const slot = inferSemanticSlot(input.category, input.content);
  const parsed = parseUserTemporal(input.content, input.ctx.now, input.ctx.timeZone);
  const openLoopTags = isOpenLoopEligible(input.content) ? [TAG_OPEN_LOOP] : [];
  let confidenceScore = input.confidenceKind === 'explicit' ? 0.92 : 0.75;
  if (parsed?.temporalConfidence === 'medium') confidenceScore = Math.min(confidenceScore, 0.7);
  if (parsed?.temporalConfidence === 'low') confidenceScore = Math.min(confidenceScore, 0.5);
  if (/\b(i think|probably)\b/i.test(input.content)) confidenceScore = Math.min(confidenceScore, 0.68);
  if (/\b(maybe|might|sometime)\b/i.test(input.content)) confidenceScore = Math.min(confidenceScore, 0.48);

  return {
    shouldPersist: input.importance > TRANSIENT_IMPORTANCE_THRESHOLD,
    importance: input.importance,
    confidenceKind: input.confidenceKind,
    confidenceScore,
    expiresAt: parsed?.expiresAt ?? resolveExpiry(input.category, input.content, input.ctx),
    occurredAt: parsed?.occurredAt,
    tags: mergeTemporalTags([...input.tags, ...openLoopTags], parsed),
    semanticSlot: slot,
    title: input.title,
    category: input.category,
    content: input.content,
    reason: input.reason,
  };
}

function inferCategoryFromText(lower: string): MemoryCategory {
  if (/\b(goal|working toward|trying to|building)\b/.test(lower)) return 'goals';
  if (/\b(train(?:ing|s|ed)?|gym|workout|exercise|switched to|i box|boxing)\b/.test(lower)) return 'fitness';
  if (/\b(study|exam|assignment|class)\b/.test(lower)) return 'study';
  if (/\b(my (?:dog|cat|pet)|my mom|my dad|my friend|my partner|my sister|my brother)\b/.test(lower)) {
    return 'people';
  }
  if (/\b(lucky number|favourite|favorite|i support)\b/.test(lower)) return 'favourites';
  if (/\b(interview|deadline|tomorrow|next week|driving test|friday|test is)\b/.test(lower)) return 'moments';
  return 'preferences';
}

function inferTitleFromText(lower: string, category: MemoryCategory): string {
  if (/\blucky number\b/.test(lower)) return 'Lucky number';
  if (/\b(?:dog|cat|pet)'s name\b/.test(lower)) return 'Pet';
  if (/\bi support\b/.test(lower)) return 'Team';
  if (/\bdriving test\b/.test(lower)) return 'Driving test';
  if (category === 'goals') return 'Personal goal';
  if (category === 'fitness') return 'Training preference';
  if (category === 'study') return 'Study context';
  if (category === 'people') return 'Important person';
  if (category === 'moments') return 'Upcoming event';
  if (category === 'favourites') return 'Favourite';
  return 'Preference';
}

function resolveExpiry(category: MemoryCategory, content: string, ctx: TemporalParseContext): string | undefined {
  const parsed = parseUserTemporal(content, ctx.now, ctx.timeZone);
  if (parsed) return parsed.expiresAt;

  if (['work', 'business', 'productivity'].includes(category)) {
    const expiry = new Date(ctx.now);
    expiry.setUTCDate(expiry.getUTCDate() + 90);
    return expiry.toISOString();
  }

  return undefined;
}

function mergeTags(base: string[] = [], extra: string[] = []): string[] {
  return [...new Set([...base, ...extra].map((tag) => tag.trim()).filter(Boolean))];
}

function sensitiveTags(text: string, base: string[]): string[] {
  if (detectMemorySensitivity(text) === 'none') return base;
  return mergeTags(base, [TAG_SENSITIVE]);
}

function normalizeWriteContext(writeContext?: MemoryWriteContext): TemporalParseContext {
  return {
    now: writeContext?.now ?? new Date(),
    timeZone: resolveDeviceTimeZone(writeContext?.timeZone),
  };
}

export function decisionToCandidate(decision: MemoryWriteDecision): ExtractedMemoryCandidate & {
  confidence?: number;
  expiresAt?: string;
  occurredAt?: string;
} {
  return {
    category: decision.category,
    title: decision.title,
    content: decision.content,
    importance: importanceFromLevel(decision.importance),
    mood: 'neutral',
    tags: decision.tags,
    confidence: decision.confidenceScore,
    expiresAt: decision.expiresAt,
    occurredAt: decision.occurredAt,
  };
}
