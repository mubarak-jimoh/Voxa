import { getCompanionMode } from '../../constants/companion-modes';
import { isFeatureVisible } from '../../config/feature-status';
import { CompanionModeId, CreateMemoryInput, CreateReminderInput } from '../../types';
import { canStartLiveVoice, liveVoiceUnavailableMessage } from '../../utils/voice-navigation';
import { IStorageService, VoxaRepositories } from '../contracts';
import { formatReminderTime } from '../../utils/reminders';
import {
  reminderScheduleConfirmation,
  scheduleLocalReminderIfAllowed,
} from '../notifications/schedule-local-reminder';
import { getRoutineCoachService } from '../routine/routine-coach-service';
import { formatTime12Hour } from '../../utils/time-parse';
import {
  ActionIntentParser,
  formatMemorySavedConfirmation,
  ParsedActionIntent,
  actionIntentParser,
} from './action-intent-parser';
import { TAG_EXPLICIT } from '../memory/memory-taxonomy';
import { ParseMessageContext, parseMessageIntent } from './action-intent-resolver';

export type ChatSideEffect =
  | { type: 'open_voice_conversation'; safe?: boolean; autoStart?: boolean }
  | { type: 'switch_mode'; mode: CompanionModeId; conversationId: string };

export type ChatActionExecutionResult = {
  success: boolean;
  confirmationMessage: string;
  sideEffect?: ChatSideEffect;
};

type ExecuteContext = {
  userId: string;
  mode: CompanionModeId;
  conversationId: string;
};

export class ChatActionExecutor {
  constructor(
    private readonly repositories: VoxaRepositories,
    private readonly parser: ActionIntentParser = actionIntentParser,
    private readonly deps: {
      switchCompanionMode: (userId: string, mode: CompanionModeId) => Promise<{
        mode: ReturnType<typeof getCompanionMode>;
        conversation: { id: string };
      }>;
      startVoiceSession: (userId: string, mode: CompanionModeId) => Promise<unknown>;
      startSafeCallSession: (userId: string) => Promise<unknown>;
      storage?: IStorageService;
    },
  ) {}

  parse(message: string): ParsedActionIntent | null {
    return this.parser.parse(message);
  }

  async parseMessage(message: string, context?: ParseMessageContext): Promise<ParsedActionIntent | null> {
    return parseMessageIntent(message, this.parser, context);
  }

  async execute(intent: ParsedActionIntent, context: ExecuteContext): Promise<ChatActionExecutionResult> {
    switch (intent.action) {
      case 'set_reminder':
        return this.executeSetReminder(intent, context);
      case 'create_goal':
        return this.executeCreateGoal(intent, context);
      case 'switch_mode':
        return this.executeSwitchMode(intent, context);
      case 'start_safe_call':
        return this.executeStartSafeCall(context);
      case 'start_voice_call':
        return this.executeStartVoiceCall(context);
      case 'add_memory':
        return this.executeAddMemory(intent, context);
      case 'create_routine':
        return this.executeCreateRoutine(intent, context);
      case 'move_routine':
        return this.executeMoveRoutine(intent, context);
      case 'routine_help':
        return this.executeRoutineHelp(context);
      default:
        return { success: false, confirmationMessage: "I couldn't do that yet, but I'm here to help." };
    }
  }

  private async executeSetReminder(
    intent: Extract<ParsedActionIntent, { action: 'set_reminder' }>,
    context: ExecuteContext,
  ): Promise<ChatActionExecutionResult> {
    const input: CreateReminderInput = {
      userId: context.userId,
      kind: 'reminder',
      title: intent.title,
      scheduledAt: intent.scheduledAt.toISOString(),
      recurrence: 'none',
      mode: context.mode,
    };

    const existing = (await this.repositories.reminders.listReminders(context.userId)).find((item) => {
      if (item.status === 'cancelled' || item.status === 'completed') return false;
      if (item.title.trim().toLowerCase() !== intent.title.trim().toLowerCase()) return false;
      return Math.abs(new Date(item.scheduledAt).getTime() - intent.scheduledAt.getTime()) < 90_000;
    });
    const reminder = existing ?? (await this.repositories.reminders.createReminder(input));
    const scheduled = await scheduleLocalReminderIfAllowed(reminder);
    if (scheduled.ok) {
      await this.repositories.reminders.updateReminder(reminder.id, { notificationId: scheduled.notificationId });
    }
    const when = formatReminderTime(intent.scheduledAt.toISOString());
    return reminderScheduleConfirmation({ title: intent.title, when, scheduled });
  }

  private async executeCreateGoal(
    intent: Extract<ParsedActionIntent, { action: 'create_goal' }>,
    context: ExecuteContext,
  ): Promise<ChatActionExecutionResult> {
    await this.repositories.goals.createGoal({
      userId: context.userId,
      title: intent.title,
      category: intent.category,
      status: 'active',
      progress: 0,
    });

    return {
      success: true,
      confirmationMessage: `Got it — I've saved your goal: "${intent.title}". We can track it together.`,
    };
  }

  private async executeSwitchMode(
    intent: Extract<ParsedActionIntent, { action: 'switch_mode' }>,
    context: ExecuteContext,
  ): Promise<ChatActionExecutionResult> {
    const result = await this.deps.switchCompanionMode(context.userId, intent.mode);
    const label = result.mode.shortLabel;

    return {
      success: true,
      confirmationMessage: `Done — I'm in ${label} mode now. ${result.mode.openingMessage}`,
      sideEffect: {
        type: 'switch_mode',
        mode: intent.mode,
        conversationId: result.conversation.id,
      },
    };
  }

  private async executeStartSafeCall(context: ExecuteContext): Promise<ChatActionExecutionResult> {
    if (!isFeatureVisible('safeCall')) {
      return {
        success: true,
        confirmationMessage: liveVoiceUnavailableMessage(true),
      };
    }
    await this.deps.startSafeCallSession(context.userId);

    return {
      success: true,
      confirmationMessage: "I'm starting Safe Call mode for you now. I'm here with you — you're not alone.",
      sideEffect: { type: 'open_voice_conversation', safe: true, autoStart: true },
    };
  }

  private async executeStartVoiceCall(_context: ExecuteContext): Promise<ChatActionExecutionResult> {
    if (!canStartLiveVoice()) {
      return {
        success: true,
        confirmationMessage: liveVoiceUnavailableMessage(false),
      };
    }

    return {
      success: true,
      confirmationMessage: 'Connecting you now — opening a live call.',
      sideEffect: { type: 'open_voice_conversation', autoStart: true },
    };
  }

  private routineCoach() {
    if (!this.deps.storage) throw new Error('Routine Coach unavailable');
    return getRoutineCoachService(this.deps.storage, this.repositories);
  }

  private async executeCreateRoutine(
    intent: Extract<ParsedActionIntent, { action: 'create_routine' }>,
    context: ExecuteContext,
  ): Promise<ChatActionExecutionResult> {
    const block = await this.routineCoach().createBlock({
      userId: context.userId,
      kind: intent.kind,
      title: intent.title,
      time: intent.time,
      mode: context.mode,
    });
    const [hour, minute] = block.time.split(':').map(Number);
    const when = formatTime12Hour(hour, minute);

    return {
      success: true,
      confirmationMessage: `Done — ${block.title} is on your routine at ${when}. I'll help you stick to it.`,
    };
  }

  private async executeMoveRoutine(
    intent: Extract<ParsedActionIntent, { action: 'move_routine' }>,
    context: ExecuteContext,
  ): Promise<ChatActionExecutionResult> {
    const blocks = await this.routineCoach().listBlocks(context.userId);
    const match =
      blocks.find((b) => b.title.toLowerCase() === intent.title.toLowerCase()) ??
      blocks.find((b) => b.title.toLowerCase().includes(intent.title.toLowerCase()));

    if (!match) {
      return {
        success: false,
        confirmationMessage: `I couldn't find "${intent.title}" in your routine. Want me to create it?`,
      };
    }

    await this.routineCoach().updateBlock(match.id, { time: intent.time });
    const [hour, minute] = intent.time.split(':').map(Number);

    return {
      success: true,
      confirmationMessage: `Moved ${match.title} to ${formatTime12Hour(hour, minute)}.`,
    };
  }

  private async executeRoutineHelp(context: ExecuteContext): Promise<ChatActionExecutionResult> {
    const summary = await this.routineCoach().getTodaySchedule(context.userId);
    if (summary.totalCount === 0) {
      return {
        success: true,
        confirmationMessage:
          "You don't have a routine yet. Tell me something like “wake me up at 7” or “remind me to study at 6”.",
      };
    }

    const next = summary.nextBlock;
    const progress = `${summary.completedCount}/${summary.totalCount}`;

    return {
      success: true,
      confirmationMessage: next
        ? `You're ${progress} through today. Next up: ${next.title}. Want to mark it done or snooze?`
        : `You're ${progress} through today's routine. Nice work.`,
    };
  }

  private async executeAddMemory(
    intent: Extract<ParsedActionIntent, { action: 'add_memory' }>,
    context: ExecuteContext,
  ): Promise<ChatActionExecutionResult> {
    const input: CreateMemoryInput = {
      userId: context.userId,
      category: intent.category,
      title: intent.title,
      content: intent.content,
      source: 'conversation',
      relatedMode: context.mode,
      importance: 4,
      confidence: 0.9,
      tags: [TAG_EXPLICIT],
    };

    await this.repositories.memories.createMemory(input);

    return {
      success: true,
      confirmationMessage: formatMemorySavedConfirmation(intent.content),
    };
  }
}
