import { TalkIntent, intentWantsLifeModules } from './companion-intent';
import { isExplicitJournalRetrieval } from '../journal/journal-signal';

export type ContextModule =
  | 'companion_core'
  | 'phase4_quality'
  | 'phase7_personality'
  | 'phase8_focused'
  | 'phase9_plan'
  | 'phase11_dashboard'
  | 'mood'
  | 'check_in'
  | 'reflection'
  | 'journal'
  | 'weather'
  | 'nutrition'
  | 'notes'
  | 'faith'
  | 'challenge';

export type RoutedContextBlocks = Partial<Record<ContextModule, string>>;

export function selectContextModules(intent: TalkIntent, userMessage: string): ContextModule[] {
  const lower = userMessage.toLowerCase();

  if (intent === 'factual_question') {
    const modules: ContextModule[] = ['phase4_quality', 'phase9_plan'];
    if (/\b(weather|rain|forecast|temperature|how hot|how cold)\b/i.test(lower)) {
      modules.push('weather');
    }
    return modules;
  }

  if (intent === 'app_action_request') {
    return ['phase4_quality', 'phase9_plan'];
  }

  const modules: ContextModule[] = ['companion_core', 'phase4_quality', 'phase9_plan'];

  if (intent !== 'casual_conversation' || textSuggestsPersonality(lower)) {
    modules.push('phase7_personality');
  }

  if (shouldIncludePhase8(intent, lower)) {
    modules.push('phase8_focused');
  }

  if (['planning', 'goal_progress', 'routine', 'productivity', 'decision_support'].includes(intent)) {
    modules.push('phase11_dashboard');
  }

  if (['emotional_support', 'reflection', 'journaling', 'motivation'].includes(intent)) {
    modules.push('mood');
  }

  if (['planning', 'productivity', 'decision_support', 'routine'].includes(intent)) {
    modules.push('check_in');
  }

  if (['reflection', 'journaling'].includes(intent)) {
    modules.push('reflection');
  }

  if (
    ['emotional_support', 'reflection', 'journaling'].includes(intent) ||
    isExplicitJournalRetrieval(userMessage)
  ) {
    modules.push('journal');
  }

  if (/\b(weather|rain|cold|hot outside|forecast)\b/i.test(lower) || intent === 'planning') {
    modules.push('weather');
  }

  if (/\b(calories|protein|meal|food log|nutrition|eat today|diet)\b/i.test(lower)) {
    modules.push('nutrition');
  }

  if (/\b(note|notes|wrote down|journal entry)\b/i.test(lower)) {
    modules.push('notes');
  }

  if (/\b(pray|faith|church|mosque|spiritual|bible|quran)\b/i.test(lower)) {
    modules.push('faith');
  }

  if (/challenge (my|me)|stress-?test|push back respectfully|challenge my thinking/i.test(userMessage)) {
    modules.push('challenge');
  }

  if (intent === 'casual_conversation' && !intentWantsLifeModules(intent)) {
    return modules.filter(
      (module) =>
        !['phase11_dashboard', 'nutrition', 'reflection', 'notes', 'faith', 'check_in', 'journal'].includes(module),
    );
  }

  return [...new Set(modules)];
}

function textSuggestsPersonality(lower: string): boolean {
  return /\b(yo|hey|bored|lol|haha|miss you|what's up|sup)\b/i.test(lower);
}

function shouldIncludePhase8(intent: TalkIntent, lower: string): boolean {
  if (['planning', 'decision_support', 'goal_progress', 'routine', 'productivity'].includes(intent)) {
    return true;
  }
  return /\b(today|tomorrow|tonight|schedule|when|plan|focus|goal|remember)\b/i.test(lower);
}

export function assembleRoutedContextExtension(
  modules: ContextModule[],
  blocks: RoutedContextBlocks,
): string {
  const parts: string[] = [];
  for (const module of modules) {
    const block = blocks[module]?.trim();
    if (block) parts.push(block);
  }
  return parts.join('\n\n');
}

export function summarizeSelectedModules(modules: ContextModule[]): string {
  return modules.join(',');
}
