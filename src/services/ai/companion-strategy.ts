import { Memory, Message } from '../../types';
import { TalkIntent, TalkIntentResult } from './companion-intent';
import { ConversationStylePreference } from '../../types/phase9-intelligence';
import { logFeature } from '../../utils/feature-logger';
import { isSupersededMemory, resolveCompanionMemoryType, TAG_EXPLICIT } from '../memory/memory-taxonomy';

export type ConversationTone =
  | 'neutral'
  | 'casual'
  | 'playful'
  | 'excited'
  | 'serious'
  | 'frustrated'
  | 'uncertain'
  | 'reflective'
  | 'supportive';

export type ConversationEnergy = 'low' | 'normal' | 'high';

export type ResponseDepth = 'micro' | 'short' | 'normal' | 'deep';

export type QuestionPolicy = 'none' | 'optional' | 'useful' | 'required';

export type ConversationState = {
  intent: TalkIntent;
  tone: ConversationTone;
  energy: ConversationEnergy;
  depth: ResponseDepth;
  questionPolicy: QuestionPolicy;
  decisionMode: boolean;
  followUp: boolean;
  referenceDependent: boolean;
};

export type CompanionStrategy = {
  state: ConversationState;
  /** Short resolved-reference hint for the model — never logged in diagnostics. */
  referenceHint?: string;
  /** Whether the current message overrides stored concise/verbose prefs. */
  currentOverridesStoredStyle: boolean;
  storedStyleHints: string[];
  recentOpenerPatterns: string[];
  promptBlock: string;
};

const DECISION_LANGUAGE =
  /\b(what should i do|which would you pick|pick one|what would you do|which is better|just tell me|be honest|give me your recommendation|just pick|compare them|help me choose|decide between)\b/i;

const PLAYFUL =
  /\b(lol|lmao|😂|🤣|bro\b|crazy|wild|no way|dead 💀|that's mad)\b/i;

const EXCITED = /\b(!{2,}|finally|got the job|nailed it|can't believe|so happy|yes!!|let's go)\b/i;

const FRUSTRATION =
  /\b(annoyed|frustrated|messed up|screwed up|ugh|this day is shit|that sucked|i messed|messed that up)\b/i;

const REFLECTIVE = /\b(don't know what to do|not sure anymore|lost|confused about|what am i doing)\b/i;

const REFERENCE_PHRASE =
  /\b(it|that|this|them|those|he|she|they|the first|the second|the third|the other one|what about later|do that|nah not that|the one before|why\??|what about me)\b/i;

const OPTION_INDEX =
  /\b(the )?(first|second|third|fourth|1st|2nd|3rd|4th|other one|other option)\b/i;

const CURRENT_DEPTH_OVERRIDE = {
  deep: /\b(explain (this )?properly|in detail|thoroughly|walk me through|break it down fully|elaborate)\b/i,
  short: /\b(keep it short|just the answer|tldr|be brief|quick answer)\b/i,
  micro: /^(thanks|thank you|ok|okay|cool|nice|yep|yeah)\b/i,
};

const DURABLE_STYLE_PHRASE =
  /\b(from now on|keep your (replies|answers) short|be more direct|don't ask me loads of questions|don't ask so many questions|i like detailed explanations|be honest and just pick|you can joke with me)\b/i;

const PRODUCTIVITY_PIVOT_BLOCKED =
  /\b(bored|nothing to do|so bored|entertain me|kill time)\b/i;

export function buildCompanionStrategy(input: {
  talkIntent: TalkIntentResult;
  userMessage: string;
  history: Message[];
  memories?: Memory[];
  stylePrefs?: ConversationStylePreference;
  recentVoxaReplies?: string[];
}): CompanionStrategy {
  const text = input.userMessage.trim();
  const lower = text.toLowerCase();
  const intent = input.talkIntent.intent;
  const referenceDependent = input.talkIntent.referencesRecentTurns || REFERENCE_PHRASE.test(lower);
  const decisionMode = intent === 'decision_support' || intent === 'planning' || DECISION_LANGUAGE.test(lower);
  const followUp = referenceDependent || OPTION_INDEX.test(lower);

  const tone = detectTone(lower, intent);
  const energy = detectEnergy(lower, tone);
  const depth = detectDepth({
    intent,
    userMessage: text,
    tone,
    decisionMode,
    stylePrefs: input.stylePrefs,
    currentOverride: detectCurrentStyleOverride(lower),
  });
  const questionPolicy = detectQuestionPolicy({
    intent,
    userMessage: text,
    depth,
    decisionMode,
    referenceDependent,
    recentVoxaReplies: input.recentVoxaReplies ?? [],
    stylePrefs: input.stylePrefs,
    memories: input.memories ?? [],
  });

  const currentOverridesStoredStyle = detectCurrentStyleOverride(lower) !== null;
  const storedStyleHints = extractConversationalPreferenceHints(input.memories ?? [], lower);
  const referenceHint = referenceDependent
    ? resolveReferenceFromHistory(text, input.history)
    : undefined;
  const recentOpenerPatterns = extractRecentOpeners(input.recentVoxaReplies ?? []);
  const boredCasual = /\bbored\b/i.test(lower) && intent === 'casual_conversation';

  const state: ConversationState = {
    intent,
    tone,
    energy,
    depth,
    questionPolicy,
    decisionMode,
    followUp,
    referenceDependent,
  };

  return {
    state,
    referenceHint,
    currentOverridesStoredStyle,
    storedStyleHints,
    recentOpenerPatterns,
    promptBlock: buildStrategyPromptBlock({
      state,
      referenceHint,
      storedStyleHints,
      currentOverridesStoredStyle,
      recentOpenerPatterns,
      blockProductivityPivot: PRODUCTIVITY_PIVOT_BLOCKED.test(lower) && intent === 'casual_conversation',
      boredCasual,
    }),
  };
}

function detectTone(lower: string, intent: TalkIntent): ConversationTone {
  if (intent === 'factual_question') return 'neutral';
  if (intent === 'celebration' || EXCITED.test(lower)) return 'excited';
  if (PLAYFUL.test(lower)) return 'playful';
  if (FRUSTRATION.test(lower)) return 'frustrated';
  if (REFLECTIVE.test(lower)) return 'reflective';
  if (intent === 'emotional_support') return 'supportive';
  if (/\b(important|serious|need to figure|deadline|interview)\b/i.test(lower)) return 'serious';
  if (intent === 'casual_conversation') return 'casual';
  if (intent === 'decision_support' || intent === 'planning') return 'neutral';
  if (/\b(maybe|not sure|either|which one)\b/i.test(lower)) return 'uncertain';
  return 'neutral';
}

function detectEnergy(lower: string, tone: ConversationTone): ConversationEnergy {
  if (tone === 'excited' || tone === 'playful') return 'high';
  if (/\b(tired|exhausted|drained|meh|bored)\b/i.test(lower)) return 'low';
  if (tone === 'frustrated' && lower.length < 80) return 'normal';
  return 'normal';
}

function detectCurrentStyleOverride(lower: string): 'deep' | 'short' | 'micro' | null {
  if (CURRENT_DEPTH_OVERRIDE.deep.test(lower)) return 'deep';
  if (CURRENT_DEPTH_OVERRIDE.short.test(lower)) return 'short';
  if (CURRENT_DEPTH_OVERRIDE.micro.test(lower)) return 'micro';
  return null;
}

function detectDepth(input: {
  intent: TalkIntent;
  userMessage: string;
  tone: ConversationTone;
  decisionMode: boolean;
  stylePrefs?: ConversationStylePreference;
  currentOverride: 'deep' | 'short' | 'micro' | null;
}): ResponseDepth {
  if (input.currentOverride === 'micro') return 'micro';
  if (input.currentOverride === 'deep') return 'deep';
  if (input.currentOverride === 'short') return 'short';

  if (input.intent === 'factual_question' && input.userMessage.length < 120) return 'micro';
  if (input.intent === 'celebration' && input.userMessage.length < 80) return 'short';
  if (input.intent === 'casual_conversation' && input.userMessage.length < 60) return 'short';
  if (/\bbored\b/i.test(input.userMessage.toLowerCase())) return 'short';
  if (input.tone === 'playful' || input.tone === 'frustrated') return 'short';
  if (input.decisionMode && input.userMessage.length < 200) return 'short';
  if (input.stylePrefs?.prefersDeep && !input.stylePrefs.prefersShort) return 'deep';
  if (input.stylePrefs?.prefersShort) return 'short';
  if (input.intent === 'planning' || input.intent === 'brainstorming') return 'normal';
  if (input.tone === 'reflective') return 'normal';
  return 'normal';
}

function detectQuestionPolicy(input: {
  intent: TalkIntent;
  userMessage: string;
  depth: ResponseDepth;
  decisionMode: boolean;
  referenceDependent: boolean;
  recentVoxaReplies: string[];
  stylePrefs?: ConversationStylePreference;
  memories: Memory[];
}): QuestionPolicy {
  const lower = input.userMessage.toLowerCase();

  if (input.intent === 'factual_question' || input.depth === 'micro') return 'none';
  if (input.intent === 'celebration') return 'none';
  if (/\bbored\b/i.test(lower) && input.intent === 'casual_conversation') return 'none';
  if (input.decisionMode && !/\?$/.test(input.userMessage.trim())) return 'none';
  if (/\b(just pick|just tell me|be honest|give me your recommendation)\b/i.test(lower)) return 'none';

  const storedNoQuestions = input.memories.some(
    (memory) =>
      !isSupersededMemory(memory) &&
      resolveCompanionMemoryType(memory.category, memory.tags) === 'conversational_preference' &&
      /\b(don't ask|fewer questions|no questions)\b/i.test(memory.content),
  );
  if (storedNoQuestions && !/\?$/.test(input.userMessage.trim())) return 'optional';

  const recentAsked = input.recentVoxaReplies.slice(-2).some((reply) => /\?\s*$/.test(reply.trim()));
  if (recentAsked && input.userMessage.length < 80) return 'none';

  if (input.referenceDependent && OPTION_INDEX.test(lower)) return 'none';

  if (input.intent === 'memory_recall') return 'optional';
  if (input.intent === 'brainstorming' || input.intent === 'advice') return 'useful';
  if (/\?$/.test(input.userMessage.trim()) && input.userMessage.length > 40) return 'useful';

  return 'optional';
}

export function resolveReferenceFromHistory(userMessage: string, history: Message[]): string | undefined {
  const lower = userMessage.toLowerCase();
  if (history.length === 0) return undefined;

  const lastVoxa = [...history].reverse().find((item) => item.role === 'voxa');
  if (lastVoxa && OPTION_INDEX.test(lower)) {
    const options = extractListedOptions(lastVoxa.content);
    if (options.length >= 2) {
      if (/\b(second|2nd|other)\b/i.test(lower)) {
        return `Resolve "the second one" as: ${options[1]}`;
      }
      if (/\b(first|1st)\b/i.test(lower)) {
        return `Resolve "the first one" as: ${options[0]}`;
      }
      if (/\b(third|3rd)\b/i.test(lower) && options[2]) {
        return `Resolve "the third one" as: ${options[2]}`;
      }
    }
  }

  const recentContext = history
    .slice(-6)
    .map((item) => `${item.role === 'user' ? 'User' : 'Voxa'}: ${String(item.content ?? '').slice(0, 160)}`)
    .join('\n');

  if (REFERENCE_PHRASE.test(lower) || lower.length < 60) {
    return `Use recent conversation to resolve references:\n${recentContext}`;
  }

  return undefined;
}

export function extractListedOptions(text: string): string[] {
  const lines = text.split('\n');
  const numbered: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:\d+[\).\:]|\-|\*)\s+(.+)/);
    if (match?.[1]) numbered.push(match[1].trim());
  }
  if (numbered.length >= 2) return numbered;

  const inline = [...text.matchAll(/\b(?:option|idea)\s+\d+[:\-]\s*([^.!\n]+)/gi)].map((m) => m[1].trim());
  if (inline.length >= 2) return inline;

  const commaList = text.match(/(?:ideas?|options?):\s*([^.!\n]+)/i);
  if (commaList?.[1]) {
    const parts = commaList[1].split(/,\s*(?:and\s+)?/i).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) return parts;
  }

  return numbered;
}

function extractConversationalPreferenceHints(memories: Memory[], currentMessage: string): string[] {
  const hints: string[] = [];
  const lower = currentMessage.toLowerCase();

  for (const memory of memories) {
    if (isSupersededMemory(memory)) continue;
    const type = resolveCompanionMemoryType(memory.category, memory.tags);
    const isStyle =
      type === 'conversational_preference' ||
      (type === 'preference' && memory.tags.includes(TAG_EXPLICIT) && /\b(reply|answer|direct|question|joke|concise|detail)\b/i.test(memory.content));
    if (!isStyle) continue;

    if (/\b(short|concise|brief)\b/i.test(memory.content) && !CURRENT_DEPTH_OVERRIDE.deep.test(lower)) {
      hints.push('Stored preference: keep replies concise unless the current message asks for detail.');
    }
    if (/\b(detail|detailed|longer explanations)\b/i.test(memory.content) && !CURRENT_DEPTH_OVERRIDE.short.test(lower)) {
      hints.push('Stored preference: user appreciates fuller explanations when relevant.');
    }
    if (/\b(direct|pick one|honest)\b/i.test(memory.content)) {
      hints.push('Stored preference: be direct and give a clear recommendation when asked.');
    }
    if (/\b(don't ask|fewer questions|no questions)\b/i.test(memory.content)) {
      hints.push('Stored preference: avoid unnecessary follow-up questions.');
    }
    if (/\b(joke|humou?r)\b/i.test(memory.content)) {
      hints.push('Stored preference: light humour is welcome when it fits.');
    }
  }

  return [...new Set(hints)];
}

export function isExplicitConversationalPreferenceMessage(text: string): boolean {
  return DURABLE_STYLE_PHRASE.test(text.trim());
}

function extractRecentOpeners(replies: string[]): string[] {
  return replies
    .slice(-3)
    .map((reply) => reply.trim().slice(0, 48).toLowerCase())
    .filter(Boolean);
}

function buildStrategyPromptBlock(input: {
  state: ConversationState;
  referenceHint?: string;
  storedStyleHints: string[];
  currentOverridesStoredStyle: boolean;
  recentOpenerPatterns: string[];
  blockProductivityPivot: boolean;
  boredCasual?: boolean;
}): string {
  const { state } = input;
  const lines = [
    '## Companion strategy (follow silently)',
    `Tone: ${state.tone}. Energy: ${state.energy}. Depth: ${state.depth}. Questions: ${state.questionPolicy}.`,
  ];

  if (state.depth === 'micro') {
    lines.push('Reply in one short sentence or a direct answer only. No preamble.');
  } else if (state.depth === 'short') {
    lines.push('Keep it brief — usually 1-3 short sentences unless detail is clearly needed.');
  } else if (state.depth === 'deep') {
    lines.push('The user wants depth — structured and thoughtful, not padded.');
  }

  if (state.questionPolicy === 'none') {
    lines.push('Do NOT end with a question. The answer should stand on its own.');
  } else if (state.questionPolicy === 'optional') {
    lines.push('Only ask a question if essential information is missing.');
  }

  if (state.decisionMode) {
    lines.push(
      'Decision mode: give your recommendation FIRST in plain language, then one brief reason. Do not hide behind endless neutrality.',
    );
  }

  switch (state.tone) {
    case 'playful':
      lines.push('Match playful energy lightly — no forced slang or cringe.');
      break;
    case 'excited':
      lines.push('Match their excitement briefly — celebrate before adding anything practical.');
      break;
    case 'frustrated':
      lines.push('Normal frustration — acknowledge briefly, then help practically. Not therapy, not crisis mode.');
      break;
    case 'serious':
      lines.push('Drop jokes. Be clear and grounded.');
      break;
    case 'casual':
      lines.push('Relaxed and conversational — not a coach unless they ask.');
      break;
    case 'supportive':
      lines.push('Warm and human — not a therapy script.');
      break;
    default:
      break;
  }

  if (input.blockProductivityPivot) {
    lines.push('Do NOT pivot to goals, focus sessions, routines, or productivity unless they ask.');
  }

  if (input.boredCasual) {
    lines.push(
      'They are bored — reply like a close friend, not an assistant. One or two short sentences. Light humour is fine. Offer something random, playful, or a game. Do NOT suggest podcasts, workouts, creative projects, or generic "try something new" lists.',
    );
  }

  if (input.referenceHint) {
    lines.push('Reference resolution: use recent conversation/history — do not ask what they mean if context is clear.');
    lines.push(input.referenceHint);
  }

  if (input.currentOverridesStoredStyle) {
    lines.push('Current message overrides stored style preferences — follow what they asked for NOW.');
  } else if (input.storedStyleHints.length > 0) {
    lines.push(input.storedStyleHints.join(' '));
  }

  if (input.recentOpenerPatterns.length > 0) {
    lines.push(`Avoid repeating these recent openings: ${input.recentOpenerPatterns.join(' | ')}`);
  }

  lines.push('Never claim human emotions or consciousness. Do not say "I feel", "I missed you", or "I need you".');

  return lines.join('\n');
}

export function logCompanionStrategyDiagnostic(input: {
  strategy: CompanionStrategy;
  contextModules: string[];
  memoryCount: number;
  totalPayloadChars?: number;
}): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;

  const { state } = input.strategy;
  logFeature(
    'companion.strategy',
    'start',
    [
      `intent=${state.intent}`,
      `tone=${state.tone}`,
      `energy=${state.energy}`,
      `depth=${state.depth}`,
      `questionPolicy=${state.questionPolicy}`,
      `decision=${state.decisionMode}`,
      `followUp=${state.followUp}`,
      `modules=${input.contextModules.join('|') || 'none'}`,
      `memories=${input.memoryCount}`,
      input.totalPayloadChars != null ? `total=${input.totalPayloadChars}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function strategyDepthToKeepShort(depth: ResponseDepth): boolean {
  return depth === 'micro' || depth === 'short';
}

export function strategyAllowsQuestion(policy: QuestionPolicy): boolean {
  return policy === 'useful' || policy === 'required';
}
