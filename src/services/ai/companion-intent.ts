import { Message } from '../../types';

export type TalkIntent =
  | 'casual_conversation'
  | 'factual_question'
  | 'planning'
  | 'decision_support'
  | 'motivation'
  | 'reflection'
  | 'memory_recall'
  | 'goal_progress'
  | 'routine'
  | 'productivity'
  | 'emotional_support'
  | 'journaling'
  | 'brainstorming'
  | 'celebration'
  | 'advice'
  | 'app_action_request'
  | 'unknown';

export type TalkIntentResult = {
  intent: TalkIntent;
  /** Recent turns suggest a follow-up reference (it, that, second one, etc.). */
  referencesRecentTurns: boolean;
};

const FOLLOW_UP_REFERENCE =
  /\b(it|that|this|them|those|he|she|they|the first|the second|the third|the other one|what i said|what you said|earlier|before|continue|carry on|what about tomorrow|what about later|same thing|do that|nah not that|the one before|why\??|what about me|what i told you about|the thing tomorrow|that thing friday|back to what we were|back to the)\b/i;

const FACTUAL =
  /^(what('s| is)|how much|how many|when is|who is|where is|calculate|convert|\d+\s*[\+\-\*\/%x×]\s*\d+|\d+\s*[\+\-\*\/%]|percent of)/i;

const MEMORY_RECALL =
  /\b(remember when|do you remember|what did i tell you|what was the name|what was that|did i mention|you know about my|told you about|when do i normally|when do i usually|what do i normally|what do i usually|do i normally|do i usually|how often do i|my usual|what(?:'s| is| was) my\b|what (?:colour|color|name) did i)\b/i;

const CELEBRATION =
  /\b(passed|got the job|nailed it|we won|i won|finally done|it's done|finished it|so happy|can't believe i)\b/i;

const EMOTIONAL =
  /\b(sad|upset|anxious|stressed|overwhelm|scared|lonely|hurt|depressed|hopeless|can't cope|nervous|worried|uneasy)\b/i;

const FRUSTRATION =
  /\b(annoyed|frustrated|messed up|screwed up|ugh|so tired of|sick of)\b/i;

const DECISION_FOLLOW_UP =
  /\b(what should i do|which would you pick|pick one|what would you do|which is better|just tell me|be honest|give me your recommendation|just pick|compare them|help me choose|decide between|should i)\b/i;

export function classifyTalkIntent(
  userMessage: string,
  recentHistory: Message[] = [],
): TalkIntentResult {
  const text = userMessage.trim();
  const lower = text.toLowerCase();
  const recentUserTexts = recentHistory
    .filter((item) => item.role === 'user')
    .slice(-3)
    .map((item) => item.content.toLowerCase());
  const referencesRecentTurns =
    FOLLOW_UP_REFERENCE.test(lower) ||
    (text.length < 80 && recentUserTexts.length > 0 && /\?/.test(text));

  if (MEMORY_RECALL.test(lower)) {
    return { intent: 'memory_recall', referencesRecentTurns };
  }

  if (CELEBRATION.test(lower)) {
    return { intent: 'celebration', referencesRecentTurns };
  }

  if (EMOTIONAL.test(lower)) {
    return { intent: 'emotional_support', referencesRecentTurns };
  }

  if (FRUSTRATION.test(lower)) {
    return { intent: 'emotional_support', referencesRecentTurns };
  }

  if (/\b(remind me|set a reminder|switch mode|open notes)\b/i.test(lower)) {
    return { intent: 'app_action_request', referencesRecentTurns };
  }

  if (FACTUAL.test(lower) && text.length < 120) {
    return { intent: 'factual_question', referencesRecentTurns };
  }

  if (/\b(goal|progress|milestone|on track|falling behind)\b/i.test(lower)) {
    return { intent: 'goal_progress', referencesRecentTurns };
  }

  if (/\b(routine|habit|schedule|morning block|evening block)\b/i.test(lower)) {
    return { intent: 'routine', referencesRecentTurns };
  }

  if (/\b(plan my|plan the|schedule my|what should i do|prioriti|organise|organize my)\b/i.test(lower)) {
    return { intent: 'planning', referencesRecentTurns };
  }

  if (/\b(should i|help me choose|decide between|which one|what would you do|just pick|pick one|be honest|just tell me|which is better|give me your recommendation)\b/i.test(lower)) {
    return { intent: 'decision_support', referencesRecentTurns };
  }

  if (/\b(journal|reflect|reflection|look back on)\b/i.test(lower)) {
    return { intent: 'journaling', referencesRecentTurns };
  }

  if (/\b(brainstorm|ideas for|what could i|give me options|three options)\b/i.test(lower)) {
    return { intent: 'brainstorming', referencesRecentTurns };
  }

  if (/\b(motivat|keep going|don't give up|push through)\b/i.test(lower)) {
    return { intent: 'motivation', referencesRecentTurns };
  }

  if (/\b(advice|what do you think about|is it a bad idea|is it okay if)\b/i.test(lower)) {
    return { intent: 'advice', referencesRecentTurns };
  }

  if (/\b(productive|focus|tasks|to-do|todo|deadline|assignment|work on)\b/i.test(lower)) {
    return { intent: 'productivity', referencesRecentTurns };
  }

  if (referencesRecentTurns && recentUserTexts.length > 0 && DECISION_FOLLOW_UP.test(lower)) {
    return { intent: 'decision_support', referencesRecentTurns: true };
  }

  if (text.length < 40 && !/\?/.test(text)) {
    return { intent: 'casual_conversation', referencesRecentTurns };
  }

  if (/\?/.test(text) && text.length < 100 && MEMORY_RECALL.test(lower)) {
    return { intent: 'memory_recall', referencesRecentTurns };
  }

  if (/\?/.test(text) && text.length < 100) {
    return { intent: 'advice', referencesRecentTurns };
  }

  return { intent: 'unknown', referencesRecentTurns };
}

export function intentWantsGoals(intent: TalkIntent): boolean {
  return [
    'planning',
    'decision_support',
    'goal_progress',
    'productivity',
    'routine',
    'motivation',
    'brainstorming',
  ].includes(intent);
}

export function intentWantsReminders(intent: TalkIntent): boolean {
  return ['planning', 'productivity', 'routine', 'decision_support'].includes(intent);
}

export function intentWantsMemories(intent: TalkIntent): boolean {
  return !['factual_question', 'app_action_request'].includes(intent);
}

export function intentWantsLifeModules(intent: TalkIntent): boolean {
  return !['factual_question', 'casual_conversation', 'celebration'].includes(intent);
}
