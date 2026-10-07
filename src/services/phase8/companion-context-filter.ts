import { UnifiedCompanionContext } from '../../types/companion-intelligence';
import { CompanionMoodV8 } from '../../types/phase8-retention';
import { moodWordingHint } from './companion-mood-service';

export type FocusedContextInput = {
  context: UnifiedCompanionContext;
  userMessage: string;
  companionMood?: CompanionMoodV8;
  calendarLine?: string | null;
  futureLine?: string | null;
  preferenceBlock?: string;
  challengeTitle?: string | null;
  relationshipStage?: string;
  todayFocus?: string;
};

/** Inject only context relevant to this reply — keeps prompts smaller. */
export function buildFocusedContextBlock(input: FocusedContextInput): string {
  const lower = input.userMessage.toLowerCase();
  const lines: string[] = ['## Focused context (use only what fits this message)'];

  if (input.todayFocus) lines.push(`Today's focus: ${input.todayFocus}`);
  if (input.calendarLine && /\b(today|tomorrow|when|schedule|time)\b/i.test(lower)) {
    lines.push(`Calendar: ${input.calendarLine}`);
  }
  if (input.futureLine) lines.push(`Resume: ${input.futureLine}`);
  if (input.companionMood) lines.push(`Your mood: ${input.companionMood}. ${moodWordingHint(input.companionMood)}`);
  if (input.relationshipStage) lines.push(`Bond: ${input.relationshipStage}`);

  const goalRelevant = input.context.activeGoals.filter(
    (g) => lower.includes((g.title ?? '').toLowerCase().slice(0, 8)) || /\bgoal\b/i.test(lower),
  );
  if (goalRelevant.length > 0) {
    lines.push(`Relevant goals: ${goalRelevant.slice(0, 2).map((g) => g.title).join(', ')}`);
  } else if (input.context.activeGoals[0] && /\bplan|focus|today\b/i.test(lower)) {
    lines.push(`Active goal: ${input.context.activeGoals[0].title}`);
  }

  const memoryRelevant = input.context.topMemories.filter(
    (m) => lower.includes((m.title ?? '').toLowerCase().slice(0, 10)),
  );
  if (memoryRelevant.length > 0) {
    lines.push(`Memory callback: "${memoryRelevant[0].title}"`);
  } else if (input.context.topMemories[0] && input.context.topMemories[0].importance >= 7) {
    lines.push(`Notable memory: ${input.context.topMemories[0].title}`);
  }

  if (input.challengeTitle && /\bchallenge|streak|habit|routine\b/i.test(lower)) {
    lines.push(`Active challenge: ${input.challengeTitle}`);
  }

  if (input.preferenceBlock && input.preferenceBlock.length > 0) {
    const prefHit = /\b(food|movie|team|music|book|travel|career)\b/i.test(lower);
    if (prefHit) lines.push(input.preferenceBlock);
  }

  if (input.context.availableInsideJokes.length > 0 && /\b(remember|haha|lol|nickname)\b/i.test(lower)) {
    lines.push(`Inside joke (max one): "${input.context.availableInsideJokes[0].label}"`);
  }

  if (lines.length <= 1) return '';
  return lines.join('\n');
}
