import { CHAT_COMPANION_MODE_IDS } from '../../constants/companion-modes';
import { AssistantActionId } from '../../types';
import { CompanionModeId, GoalCategory, MemoryCategory } from '../../types';
import { parseFlexibleTimeInput } from '../../utils/time-parse';
import { resolveRelativeReminderDelayMs } from './relative-reminder-time';

export type ParsedSetReminderIntent = {
  action: 'set_reminder';
  title: string;
  scheduledAt: Date;
};

export type ParsedCreateGoalIntent = {
  action: 'create_goal';
  title: string;
  category: GoalCategory;
};

export type ParsedSwitchModeIntent = {
  action: 'switch_mode';
  mode: CompanionModeId;
};

export type ParsedStartSafeCallIntent = {
  action: 'start_safe_call';
};

export type ParsedStartVoiceCallIntent = {
  action: 'start_voice_call';
};

export type ParsedAddMemoryIntent = {
  action: 'add_memory';
  title: string;
  content: string;
  category: MemoryCategory;
};

export type ParsedCreateRoutineIntent = {
  action: 'create_routine';
  title: string;
  time: string;
  kind: import('../../types/routine').RoutineBlockKind;
};

export type ParsedMoveRoutineIntent = {
  action: 'move_routine';
  title: string;
  time: string;
};

export type ParsedRoutineHelpIntent = {
  action: 'routine_help';
};

export type ParsedActionIntent =
  | ParsedSetReminderIntent
  | ParsedCreateGoalIntent
  | ParsedSwitchModeIntent
  | ParsedStartSafeCallIntent
  | ParsedStartVoiceCallIntent
  | ParsedAddMemoryIntent
  | ParsedCreateRoutineIntent
  | ParsedMoveRoutineIntent
  | ParsedRoutineHelpIntent;

const MODE_ALIASES: Record<string, CompanionModeId> = {
  friend: 'friend',
  assistant: 'assistant',
  teacher: 'teacher',
  coach: 'coach',
  reflection: 'reflection',
  safe: 'safe_call',
  'safe call': 'safe_call',
};

/**
 * Rule-based chat command parser. No OpenAI function calling.
 */
export class ActionIntentParser {
  parse(message: string): ParsedActionIntent | null {
    const text = message.trim();
    if (text.length < 4) return null;

    return (
      this.parseSetReminder(text) ??
      this.parseCreateRoutine(text) ??
      this.parseMoveRoutine(text) ??
      this.parseRoutineHelp(text) ??
      this.parseCreateGoal(text) ??
      this.parseSwitchMode(text) ??
      this.parseStartSafeCall(text) ??
      this.parseStartVoiceCall(text) ??
      this.parseAddMemory(text)
    );
  }

  getActionId(intent: ParsedActionIntent): AssistantActionId {
    return intent.action;
  }

  private parseRoutineHelp(text: string): ParsedRoutineHelpIntent | null {
    if (
      /help me stick to my routine|stick to my routine|make me a schedule|build me a schedule|create a schedule for me/i.test(
        text,
      )
    ) {
      return { action: 'routine_help' };
    }
    return null;
  }

  private parseCreateRoutine(text: string): ParsedCreateRoutineIntent | null {
    const lower = text.toLowerCase();

    const wakeMatch = text.match(/wake me up at\s+(.+)/i);
    if (wakeMatch) {
      const parsed = parseFlexibleTimeInput(wakeMatch[1]);
      if (parsed) {
        return { action: 'create_routine', title: 'Wake up', time: parsed.formatted, kind: 'wake' };
      }
    }

    const gymMatch = text.match(/(?:create|make|build)\s+(?:a\s+)?gym schedule(?: at\s+(.+))?/i);
    if (gymMatch) {
      const timePart = gymMatch[1] ?? text.match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i)?.[1];
      const parsed = timePart ? parseFlexibleTimeInput(timePart) : null;
      return {
        action: 'create_routine',
        title: 'Gym',
        time: parsed?.formatted ?? '18:00',
        kind: 'gym',
      };
    }

    const studyMatch = text.match(/remind me to study at\s+(.+)/i);
    if (studyMatch) {
      const parsed = parseFlexibleTimeInput(studyMatch[1]);
      if (parsed) {
        return { action: 'create_routine', title: 'Study', time: parsed.formatted, kind: 'study' };
      }
    }

    if (/create a gym schedule|gym at/i.test(lower)) {
      const timePart = text.match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})/i)?.[1];
      const parsed = timePart ? parseFlexibleTimeInput(timePart) : null;
      return {
        action: 'create_routine',
        title: 'Gym',
        time: parsed?.formatted ?? '18:00',
        kind: 'gym',
      };
    }

    return null;
  }

  private parseMoveRoutine(text: string): ParsedMoveRoutineIntent | null {
    const match = text.match(/move my\s+(.+?)\s+(?:time\s+)?to\s+(.+)/i);
    if (!match) return null;
    const parsed = parseFlexibleTimeInput(match[2]);
    if (!parsed) return null;
    return {
      action: 'move_routine',
      title: capitalizeFirst(match[1].trim()),
      time: parsed.formatted,
    };
  }

  private parseSetReminder(text: string): ParsedSetReminderIntent | null {
    const lower = text.toLowerCase();
    if (!/(remind me|set a reminder|set reminder|schedule a reminder)/i.test(text)) {
      return null;
    }

    const scheduledAt = parseTimeFromText(text);
    if (!scheduledAt) return null;

    const titleMatch =
      text.match(/remind me to (.+?)(?:\s+at\s+|\s+by\s+|\s+on\s+|\s+\d)/i) ??
      text.match(/remind me to (.+)/i) ??
      text.match(/remind me (?:at|@)\s+.+?\s+to\s+(.+)/i) ??
      text.match(/remind me in\s+.+?\s+to\s+(.+)/i) ??
      text.match(/(?:set|schedule) a reminder(?: to| for)? (.+?)(?:\s+at\s+|\s+\d)/i) ??
      text.match(/(?:set|schedule) a reminder(?: to| for)? (.+)/i);

    let title = titleMatch?.[1]?.trim() ?? 'Reminder';
    title = title.replace(/\s+at\s+.*$/i, '').replace(/\s+\d{1,2}(:\d{2})?\s*(am|pm)?.*$/i, '').trim();
    if (!title) title = 'Reminder';

    return { action: 'set_reminder', title: capitalizeFirst(title), scheduledAt };
  }

  private parseCreateGoal(text: string): ParsedCreateGoalIntent | null {
    const match =
      text.match(/(?:my goal is to|my goal is|goal is to|goal:)\s+(.+)/i) ??
      text.match(/(?:i want to|i'm trying to|i am trying to)\s+(.+?)\s+as a goal/i);

    if (!match) return null;

    const title = capitalizeFirst(match[1].trim().replace(/[.!?]+$/, ''));
    return {
      action: 'create_goal',
      title,
      category: inferGoalCategory(title),
    };
  }

  private parseSwitchMode(text: string): ParsedSwitchModeIntent | null {
    const lower = text.toLowerCase();
    if (!/(switch to|change to|be my|act as|use)\s+.+(mode)?/i.test(lower) && !/^(friend|assistant|teacher|coach|reflection)\s+mode$/i.test(lower)) {
      if (!/switch to/i.test(lower)) return null;
    }

    for (const [alias, mode] of Object.entries(MODE_ALIASES)) {
      if (!CHAT_COMPANION_MODE_IDS.includes(mode as CompanionModeId) && mode !== 'safe_call') continue;
      const pattern = new RegExp(`(?:switch to|change to|be my|act as|use)\\s+${alias}(?:\\s+mode)?`, 'i');
      if (pattern.test(lower) || lower === `${alias} mode`) {
        if (mode === 'safe_call') continue;
        return { action: 'switch_mode', mode };
      }
    }

    const explicit = lower.match(/switch to (\w+)(?:\s+mode)?/);
    if (explicit) {
      const mode = MODE_ALIASES[explicit[1]];
      if (mode && mode !== 'safe_call' && CHAT_COMPANION_MODE_IDS.includes(mode)) {
        return { action: 'switch_mode', mode };
      }
    }

    return null;
  }

  private parseStartSafeCall(text: string): ParsedStartSafeCallIntent | null {
    if (/(start a safe call|begin safe call|safe call mode|start safe call|need a safe call)/i.test(text)) {
      return { action: 'start_safe_call' };
    }
    return null;
  }

  private parseStartVoiceCall(text: string): ParsedStartVoiceCallIntent | null {
    if (/(call voxa|voice call|start a voice call|start voice call|call me)/i.test(text)) {
      if (/safe call/i.test(text)) return null;
      return { action: 'start_voice_call' };
    }
    return null;
  }

  private parseAddMemory(text: string): ParsedAddMemoryIntent | null {
    if (/remind me/i.test(text)) return null;
    const content = extractRememberedFact(text);
    if (!content) return null;
    const category = inferMemoryCategory(content);
    const title = buildMemoryTitle(content, category);
    return { action: 'add_memory', title, content, category };
  }
}

function parseTimeFromText(text: string): Date | null {
  const lower = text.toLowerCase();
  const now = new Date();

  const relativeMs = resolveRelativeReminderDelayMs(lower);
  if (relativeMs != null) {
    return new Date(now.getTime() + relativeMs);
  }

  const twelveHour = lower.match(/\b(at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (twelveHour) {
    let hour = Number(twelveHour[2]);
    const minute = twelveHour[3] ? Number(twelveHour[3]) : 0;
    const meridiem = twelveHour[4].toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return buildScheduledDate(now, hour, minute);
  }

  const twentyFour = lower.match(/\b(at\s+)?(\d{1,2}):(\d{2})\b/);
  if (twentyFour) {
    const hour = Number(twentyFour[2]);
    const minute = Number(twentyFour[3]);
    if (hour <= 23) return buildScheduledDate(now, hour, minute);
  }

  const bareHour = lower.match(/\b(at\s+)?(\d{1,2})\s*(pm|am)\b/i);
  if (bareHour) {
    let hour = Number(bareHour[2]);
    const meridiem = bareHour[3].toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return buildScheduledDate(now, hour, 0);
  }

  return null;
}

function buildScheduledDate(from: Date, hour: number, minute: number): Date {
  const scheduled = new Date(from);
  scheduled.setSeconds(0, 0);
  scheduled.setHours(hour, minute, 0, 0);
  if (scheduled.getTime() <= from.getTime()) {
    scheduled.setDate(scheduled.getDate() + 1);
  }
  return scheduled;
}

function inferGoalCategory(title: string): GoalCategory {
  const lower = title.toLowerCase();
  if (/lose|weight|run|gym|fitness|workout|kg|lbs/.test(lower)) return 'fitness';
  if (/study|exam|class|learn|read/.test(lower)) return 'study';
  if (/business|startup|revenue|client/.test(lower)) return 'business';
  if (/save|money|budget|invest/.test(lower)) return 'money';
  if (/feel|stress|anxiety|mindful|journal/.test(lower)) return 'emotional';
  if (/productive|focus|habit|routine/.test(lower)) return 'productivity';
  return 'general';
}

const REMEMBER_CUE =
  /\b(please )?(remember that|remember this|don't forget that|do not forget that|don't forget|do not forget)\b/gi;

/** Fact to store from an explicit remember request. Never store a bare "that". */
export function extractRememberedFact(message: string): string | undefined {
  if (!/\b(remember (that|this)|don't forget|do not forget)\b/i.test(message)) return undefined;
  const fact = message
    .replace(REMEMBER_CUE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.!?,\-–—]+/, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  if (fact.length < 4) return undefined;
  if (/^(that|this|it)$/i.test(fact)) return undefined;
  return fact;
}

export function formatMemorySavedConfirmation(content: string): string {
  const fact = content
    .trim()
    .replace(/^[.!?,\-–—]+/, '')
    .replace(/[.!?]+$/g, '')
    .replace(/^(that|this)\s+/i, '')
    .trim();
  if (fact.length < 4 || /^(that|this|it)$/i.test(fact)) return "Saved — I'll remember that.";
  const rest = fact.charAt(0).toLowerCase() + fact.slice(1);
  return `Saved — I'll remember that ${rest}.`;
}

function inferMemoryCategory(content: string): MemoryCategory {
  const lower = content.toLowerCase();
  if (/birthday|born on/.test(lower)) return 'birthdays';
  if (/sister|brother|mom|dad|friend|partner|wife|husband/.test(lower)) return 'people';
  if (/goal|want to/.test(lower)) return 'goals';
  if (/prefer|favorite|favourite|like/.test(lower)) return 'preferences';
  if (/afraid|worried|fear/.test(lower)) return 'fears';
  return 'moments';
}

function buildMemoryTitle(content: string, category: MemoryCategory): string {
  if (category === 'birthdays') return 'Birthday';
  if (category === 'people') {
    const relation = content.match(/\b(sister|brother|mom|mum|dad|friend|partner)\b/i)?.[1];
    if (relation) return `${capitalizeFirst(relation)} note`;
  }
  return capitalizeFirst(content.slice(0, 48)) + (content.length > 48 ? '…' : '');
}

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const actionIntentParser = new ActionIntentParser();
