import { TalkIntent } from '../ai/companion-intent';
import { ConversationState, QuestionPolicy } from '../ai/companion-strategy';
import { humourIsSuppressed, ResponseStance } from '../ai/turn-intelligence-plan';
import { SmartSuggestion } from '../../types/phase9-intelligence';
import { createUuid } from '../../types';

const SUMMARISE_PROMPT = 'Summarise that for me in a few short sentences';

function suggestion(label: string, prompt: string, priority: number): SmartSuggestion {
  return {
    id: createUuid(),
    kind: 'focus_session',
    label,
    prompt,
    priority,
  };
}

export function userAskedForSummary(userMessage: string): boolean {
  return /\b(summarise|summarize|tldr|tl;dr)\b/i.test(userMessage);
}

/** Long, multi-sentence replies only — not tiny or already-requested summaries. */
export function replyIsWorthSummarising(reply: string, userMessage = ''): boolean {
  if (userAskedForSummary(userMessage)) return false;
  const text = reply.trim();
  if (text.length < 420) return false;
  const sentences = text.split(/[.!?]+/).map((part) => part.trim()).filter((part) => part.length > 18);
  return sentences.length >= 3;
}

function looksLikeAChoice(userMessage: string, voxaReply: string): boolean {
  const user = userMessage.toLowerCase();
  if (/\b(which (one|should|is|would)|decide between|compare them|pick one|just pick)\b/.test(user)) {
    return true;
  }
  if (/\bbetween\b.+\band\b/.test(user) || /\bshould i\b.+\bor\b/.test(user)) return true;
  const listed = voxaReply.split('\n').filter((line) => /^\s*(\d+\.|[-•])\s+\S/.test(line));
  return listed.length >= 2;
}

function summariseChip(userMessage: string, voxaReply: string): SmartSuggestion[] {
  if (!replyIsWorthSummarising(voxaReply, userMessage)) return [];
  return [suggestion('Summarise', SUMMARISE_PROMPT, 88)];
}

export function playfulChipsForbidden(input: {
  userMessage: string;
  humourSuppressed?: boolean;
}): boolean {
  if (input.humourSuppressed) return true;
  return humourIsSuppressed(input.userMessage, 'unknown', 'support');
}

/**
 * Stance-first chips for the current turn.
 * Empty is a valid result — do not invent engagement filler.
 */
export function buildContextualSuggestions(input: {
  talkIntent: TalkIntent;
  userMessage: string;
  voxaReply: string;
  strategy?: ConversationState;
  stance?: ResponseStance;
  humourSuppressed?: boolean;
  questionPolicy?: QuestionPolicy;
}): SmartSuggestion[] {
  const user = input.userMessage.trim();
  const lower = user.toLowerCase();
  const intent =
    input.talkIntent === 'memory_recall' || input.talkIntent === 'factual_question'
      ? input.talkIntent
      : (input.strategy?.intent ?? input.talkIntent);
  const stance = input.stance;
  const safety = playfulChipsForbidden({
    userMessage: user,
    humourSuppressed: input.humourSuppressed,
  });

  if (safety) return [];
  if (intent === 'celebration' || stance === 'celebrate') return [];
  if (intent === 'factual_question' || stance === 'inform') {
    return summariseChip(user, input.voxaReply);
  }
  if (stance === 'listen' && (/\b(just (need to )?vent|don't want advice|do not want advice|please just listen|no advice)\b/i.test(lower) || intent === 'emotional_support')) {
    return [];
  }
  if (intent === 'emotional_support' && stance !== 'plan' && stance !== 'coach') {
    return [];
  }

  switch (intent) {
    case 'casual_conversation':
      if (/\bbored\b/.test(lower)) {
        return [
          suggestion('Something random', 'Give me something random', 90),
          suggestion('Play something', "Let's play something", 85),
          suggestion('Talk to me', 'Talk to me', 80),
        ];
      }
      return [];

    case 'planning':
    case 'productivity':
    case 'routine':
      return [
        suggestion('Make me a plan', 'Make me a plan for this', 90),
        suggestion('Prioritise these', 'Prioritise these for me', 85),
        suggestion('Break it into steps', 'Break this into steps', 80),
      ];

    case 'decision_support':
      if (looksLikeAChoice(user, input.voxaReply)) {
        return [
          suggestion('Pick one', 'Pick one for me', 90),
          suggestion('Compare them', 'Compare them', 85),
        ];
      }
      break;

    case 'memory_recall':
      return [
        suggestion('What else?', 'What else do you remember about me?', 90),
        suggestion('Remember this', 'Remember this for me', 85),
      ];

    case 'brainstorming':
      return [
        suggestion('More ideas', 'Give me more ideas', 85),
        suggestion('Pick one', 'Pick the strongest option', 80),
      ];

    default:
      break;
  }

  const chips = summariseChip(user, input.voxaReply);
  if (
    /\b(explain|how (do|does|can)|what is|what are|in simple terms)\b/i.test(user) &&
    input.voxaReply.trim().length >= 220 &&
    !userAskedForSummary(user)
  ) {
    chips.push(suggestion('Give me an example', 'Give me a simple example', 82));
  }
  if (looksLikeAChoice(user, input.voxaReply) && intent === 'advice') {
    chips.push(suggestion('Help me decide', 'Help me decide', 80));
  }

  if (stance === 'challenge') return chips.slice(0, 3);
  return chips.slice(0, 3);
}

export function contextualSuggestionPrompts(input: {
  talkIntent: TalkIntent;
  userMessage: string;
  voxaReply: string;
}): string[] {
  return buildContextualSuggestions(input).map((item) => item.prompt);
}

/**
 * Turn-level chips win, including an intentional empty list
 * (e.g. factual answers should not fall back to coach/planning starters).
 */
export function resolveTurnSuggestionPrompts(input: {
  contextual?: Array<{ prompt: string }>;
  fallback: string[];
}): string[] {
  if (input.contextual) {
    return input.contextual.map((item) => item.prompt).filter((prompt) => prompt.trim().length > 0);
  }
  return input.fallback.filter((prompt) => prompt.trim().length > 0);
}
