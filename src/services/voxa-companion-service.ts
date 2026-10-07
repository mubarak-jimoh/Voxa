import { getCompanionMode } from '../constants/companion-modes';
import { VOXA_SAFETY } from '../constants/safety';
import {
  CompanionModeId,
  Conversation,
  ConversationChannel,
  CreateGoalInput,
  CreateReminderInput,
  DailyBriefing,
  Goal,
  Memory,
  MemorySource,
  Message,
  MessageAttachment,
  PendingAttachmentInput,
  Reminder,
  attachmentDisplayLabel,
  toChatMessageView,
  TrustedContact,
  UserProfile,
  VoiceSession,
  createId,
  nowIso,
} from '../types';
import { GenerateReplyResult, VoxaRepositories } from './contracts';
import { IAIService } from './contracts';
import { buildDailyBriefing } from '../utils/daily-briefing';
import { buildVoxaCheckInConfirmation, formatReminderTime, getUpcomingReminders } from '../utils/reminders';
import { actionIntentParser } from './actions/action-intent-parser';
import { ChatActionExecutor } from './actions/chat-action-executor';
import { CompanionIntelligenceService } from './intelligence/companion-intelligence-service';
import { HomeIntelligenceSnapshot } from '../types/companion-intelligence';
import { parseMusicIntent } from './music/music-recognition-service';
import { createAttachmentProcessor } from './attachments/attachment-processor';
import { attachmentStorageService } from './attachments/attachment-storage-service';
import { FeatureGateService } from './billing/feature-gate-service';
import { FeatureLimitError, SubscriptionService } from './billing/subscription-service';
import { UsageTrackingService } from './billing/usage-tracking-service';
import { GateResult } from '../types/subscription';
import { asArray } from '../utils/as-array';
import { logFeature } from '../utils/feature-logger';
import { talkPerf, talkPerfNow } from '../utils/talk-perf';
import { buildLocalTalkMessage, talkIntentSkipsMemoryRetrieval } from './chat/talk-critical-path';
import { isBillingDormant } from '../config/launch-mode';
import { buildWowExperience, WowExperienceData } from './wow/wow-experience-service';
import { buildPhase2Dashboard } from './intelligence/phase2-dashboard-service';
import { buildPhase3Dashboard } from './intelligence/phase3-dashboard-service';
import { getWeeklyGrowthService } from './intelligence/weekly-growth-service';
import { getMoodIntelligenceService } from './intelligence/mood-intelligence-service';
import { buildChallengeMePromptExtension } from './chat/challenge-me-prompt';
import { getDailyCheckInService } from './check-in/daily-check-in-service';
import { buildTodayCheckInPromptBlock } from '../utils/daily-mood';
import { getCompanionJournalService } from './journal/companion-journal-service';
import { loadJournalTalkContext } from './journal/journal-intelligence-service';
import { getRitualService } from './ritual/ritual-service';
import { Phase2DashboardData } from '../types/phase2-intelligence';
import { Phase3DashboardData, AdaptiveModeLabel } from '../types/phase3-intelligence';
import { Phase4DashboardData, ChatExperiencePayload, SmartChatAction } from '../types/phase4-intelligence';
import { Phase5DashboardData } from '../types/phase5-life-os';
import { Phase6DashboardData } from '../types/phase6-premium';
import { Phase7DashboardData } from '../types/phase7-signature';
import { Phase8DashboardData } from '../types/phase8-retention';
import { Phase9DashboardData } from '../types/phase9-intelligence';
import { Phase10DashboardData } from '../types/phase10-play';
import { Phase11DashboardData } from '../types/phase11-living-companion';
import { Phase12DashboardData } from '../types/phase12-experiences';
import { buildPhase4Dashboard } from './intelligence/phase4-dashboard-service';
import { buildPhase5Dashboard } from './life-os/phase5-dashboard-service';
import { getPhase5LifeOSService } from './life-os/phase5-life-os-service';
import { buildPhase6Dashboard } from './phase6/phase6-dashboard-service';
import { buildPhase7Dashboard } from './phase7/phase7-dashboard-service';
import { buildPhase8Dashboard } from './phase8/phase8-dashboard-service';
import { buildPhase9Dashboard } from './phase9/phase9-dashboard-service';
import { buildPhase10Dashboard, emptyGrowth } from './phase10/phase10-dashboard-service';
import { getXpService } from './phase10/xp-service';
import { buildPhase11Dashboard, buildPhase11PromptForChat } from './phase11/phase11-dashboard-service';
import { getFollowUpEngineService } from './phase11/follow-up-engine-service';
import { getProactiveCheckInOrchestrator } from './proactive-check-ins/proactive-check-in-orchestrator';
import { buildPhase11PromptExtension, styleHintsFromPrefs } from './phase11/phase11-prompt-service';
import { buildPhase12Dashboard } from './phase12/phase12-dashboard-service';
import { buildPhase9PromptExtension } from './phase9/phase9-prompt-service';
import { planResponse, polishResponse, scoreResponseQuality } from './phase9/response-planner-service';
import { getConversationStyleMemoryService } from './phase9/conversation-style-memory-service';
import { buildContextualSuggestions } from './chat/contextual-suggestions-service';
import { buildPhase8PromptExtension } from './phase8/phase8-prompt-service';
import { buildFocusedContextBlock } from './phase8/companion-context-filter';
import { getFutureConversationsService } from './phase8/future-conversations-service';
import { getPreferenceMemoryService } from './phase8/preference-memory-service';
import { getWorkspaceSessionsService } from './phase8/workspace-sessions-service';
import { getSharedChallengesService } from './phase8/shared-challenges-service';
import { buildLifeCalendar } from './phase8/life-calendar-service';
import { buildPhase7PromptExtension } from './phase7/personality-v4-service';
import { stagePromptBlock } from './phase7/relationship-evolution-service';
import {
  getRelationshipGrowthService,
  resolveFriendshipLevel,
} from './relationship/relationship-growth-service';
import { FRIENDSHIP_LEVEL_LABELS } from '../types/relationship-growth';
import { buildWeatherPromptBlock, weatherPromptIsGrounded } from './weather/weather-ai-tool-service';
import { getWeatherService } from './weather/weather-service';
import { getNutritionService } from './nutrition/nutrition-service';
import { getDaysSinceLastVisit } from './companion/companion-presence-service';
import { STORAGE_KEYS } from '../constants/storage-keys';
import { buildStudioExtendedPromptBlock, CompanionStudioExtendedPrefs, createDefaultStudioExtendedPrefs } from '../constants/companion-studio-extended';
import { parseRichResponse } from './phase6/rich-response-parser';
import { getLifeOSService } from './life-os/life-os-service';
import { smartChatActionsService } from './intelligence/smart-chat-actions-service';
import { getConversationCanvasService } from './intelligence/conversation-canvas-service';
import { personalityV3Service } from './intelligence/personality-v3-service';
import { modeInferenceEngine } from './intelligence/mode-inference-engine';
import { getDelightMomentsService } from './intelligence/delight-moments-service';
import { buildPhase4PromptExtension } from './intelligence/conversation-quality-service';
import { getRoutineCoachService } from './routine/routine-coach-service';
import { routineProactiveService } from './proactive/routine-proactive-service';
import { TodayRoutineSummary } from '../types/routine';
import { IStorageService } from './contracts';
import { classifyTalkIntent } from './ai/companion-intent';
import {
  resolveLiveInformationPlan,
  shapeLivePublicAnswer,
  WEATHER_ASK_CITY_USER_LINE,
} from './ai/live-information';
import { sanitizeTalkDisplayText } from './chat/sanitize-talk-display';
import {
  DISTANCE_UNVERIFIED_LINE,
  formatVerifiedDistanceReply,
  lookupStraightLineDistance,
  parseDistanceQuestion,
} from './location/postcode-distance';
import { resolveImageUrlForVision, stripVisionPlaceholdersFromUserText } from './ai/vision-follow-up';
import { buildCompanionStrategy, logCompanionStrategyDiagnostic } from './ai/companion-strategy';
import { buildTurnIntelligencePlan } from './ai/turn-intelligence-plan';
import {
  assembleRoutedContextExtension,
  ContextModule,
  selectContextModules,
} from './ai/companion-context-router';

export type CompanionBillingDeps = {
  subscription: SubscriptionService;
  featureGate: FeatureGateService;
  usageTracking: UsageTrackingService;
};

export type SendChatMessageInput = {
  userId: string;
  conversationId: string;
  content: string;
  mode: CompanionModeId;
  attachments?: PendingAttachmentInput[];
  /** Already-loaded Talk profile — skips a remote profile refetch on the send path. */
  loadedProfile?: UserProfile;
  /** Already-visible conversation turns — skips a remote history refetch when present. */
  recentHistory?: Message[];
  /** Retry a persisted user turn without inserting a duplicate. */
  existingUserMessage?: Message;
};

export type SendChatMessageOptions = {
  onStreamChunk?: (chunk: string) => void;
  /** Fired after the assistant text exists and is saved locally, before remote persist. */
  onAssistantReady?: (ready: { userMessage: Message; voxaMessage: Message }) => void;
};

export type SendChatMessageResult = {
  userMessage: Message;
  voxaMessage: Message;
  aiMeta?: GenerateReplyResult;
  executedAction?: import('../types').AssistantActionId;
  sideEffect?: import('./actions/chat-action-executor').ChatSideEffect;
  adaptiveModeLabel?: AdaptiveModeLabel;
  chatExperience?: ChatExperiencePayload;
  richReply?: import('../types/phase6-premium').RichReplyPayload;
  phase9Suggestions?: import('../types/phase9-intelligence').SmartSuggestion[];
};

export type HomeDashboardData = {
  profile: UserProfile;
  memories: Memory[];
  reminders: Reminder[];
  upcomingReminders: Reminder[];
  activeGoals: Goal[];
  dailyBriefing: DailyBriefing;
  recentConversation: Conversation | null;
  recentMessages: Message[];
  insights: Array<{ id: string; label: string; value: string; detail: string }>;
  companionPrompt: string;
  companionNote: string;
  homeIntelligence: HomeIntelligenceSnapshot;
  relationshipSummary: string;
  wowExperience: WowExperienceData;
  routineSummary: TodayRoutineSummary;
  routineMessage: string | null;
  phase2: Phase2DashboardData;
  phase3: Phase3DashboardData;
  phase4: Phase4DashboardData;
  phase5: Phase5DashboardData;
  phase6: Phase6DashboardData;
  phase7: Phase7DashboardData;
  phase8: Phase8DashboardData;
  phase9: Phase9DashboardData;
  phase10: Phase10DashboardData;
  phase11: Phase11DashboardData;
  phase12: Phase12DashboardData;
};

export type CreateReminderResult = {
  reminder: Reminder;
  confirmationMessage: string;
};

export type SessionStartResult = {
  conversation: Conversation;
  openingMessage: Message;
  voiceSession: VoiceSession;
};

export type CreateGoalResult = {
  goal: Goal;
  linkedReminder?: Reminder;
};

/**
 * High-level companion orchestration for chat-like flows.
 * UI screens can call this instead of wiring repositories + AI directly.
 */
export class VoxaCompanionService {
  private readonly chatActions: ChatActionExecutor;
  private readonly billing?: CompanionBillingDeps;
  private readonly storage?: IStorageService;

  constructor(
    private readonly repositories: VoxaRepositories,
    private readonly ai: IAIService,
    private readonly memoryEngine: import('./memory/memory-intelligence-service').MemoryIntelligenceService,
    private readonly companionIntelligence: CompanionIntelligenceService,
    billing?: CompanionBillingDeps,
    storage?: IStorageService,
  ) {
    this.billing = billing;
    this.storage = storage;
    this.chatActions = new ChatActionExecutor(this.repositories, actionIntentParser, {
      switchCompanionMode: (userId, mode) => this.switchCompanionMode(userId, mode),
      startVoiceSession: (userId, mode) => this.startVoiceSession(userId, mode),
      startSafeCallSession: (userId) => this.startSafeCallSession(userId),
      storage,
    });
  }

  private async assertGate(gate: GateResult) {
    if (!gate.allowed) {
      throw new FeatureLimitError(
        gate.reason ?? 'Upgrade to Voxa Pro to continue.',
        gate.feature,
        Boolean(gate.limitReached),
      );
    }
  }

  private async getBillingContext(userId: string, profile: UserProfile) {
    if (!this.billing) return null;
    const planStatus = await this.billing.subscription.buildPlanStatus(userId, profile.subscription);
    const usage = await this.billing.usageTracking.getUsage(userId);
    return { planStatus, usage };
  }

  async getPlanStatusForUser(userId: string) {
    if (!this.billing) return null;
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile) return null;
    return this.billing.subscription.buildPlanStatus(userId, profile.subscription);
  }

  async getOrCreateProfile(displayName: string): Promise<UserProfile> {
    const existing = await this.repositories.userProfile.getProfile();
    if (existing) return existing;
    return this.repositories.userProfile.createProfile({ displayName });
  }

  async getProfile(): Promise<UserProfile | null> {
    return this.repositories.userProfile.getProfile();
  }

  async getOrCreateConversation(
    userId: string,
    mode: CompanionModeId,
    channel: ConversationChannel,
    title?: string,
  ): Promise<Conversation> {
    const conversations = await this.repositories.conversations.listConversations(userId);
    const existing = conversations.find(
      (item) => item.mode === mode && item.channel === channel && item.status === 'active',
    );
    if (existing) return existing;

    return this.repositories.conversations.createConversation({
      userId,
      mode,
      channel,
      title,
    });
  }

  async getHomeDashboard(userId: string): Promise<HomeDashboardData> {
    return this.buildHomeDashboard(userId);
  }

  private async buildHomeDashboard(userId: string): Promise<HomeDashboardData> {
    let stage = 'profile';
    try {
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile) throw new Error('User profile not found');

    stage = 'repos';
    const settled = await Promise.allSettled([
      this.repositories.memories.listMemories(userId),
      this.repositories.reminders.listReminders(userId),
      this.repositories.conversations.listConversations(userId),
      this.repositories.goals.listActiveGoals(userId),
      this.repositories.voiceSessions.listSessions(userId),
    ]);

    const memories = asArray<Memory>(settled[0].status === 'fulfilled' ? settled[0].value : []);
    const reminders = asArray<Reminder>(settled[1].status === 'fulfilled' ? settled[1].value : []);
    const conversations = asArray<Conversation>(settled[2].status === 'fulfilled' ? settled[2].value : []);
    const activeGoals = asArray<Goal>(settled[3].status === 'fulfilled' ? settled[3].value : []);
    const voiceSessions = asArray<VoiceSession>(settled[4].status === 'fulfilled' ? settled[4].value : []);

    if (__DEV__) {
      settled.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(`[HomeDashboard] repo fetch ${index} failed:`, result.reason);
        }
      });
    }

    stage = 'homeIntelligence';
    const upcomingReminders = getUpcomingReminders(reminders, 5);
    const homeIntelligence = await this.companionIntelligence.generateHomeIntelligence(userId, profile);
    stage = 'bundle';
    const bundle = await this.companionIntelligence.getBundle(userId, profile.displayName ?? 'friend');

    stage = 'dailyBriefing';
    const dailyBriefing = buildDailyBriefing({
      profile,
      memories,
      reminders,
      activeGoals,
    });
    dailyBriefing.greeting = homeIntelligence.personalGreeting;
    dailyBriefing.personalMessage = homeIntelligence.dailyFocus;
    dailyBriefing.suggestedAction = homeIntelligence.suggestedConversation;
    const upcomingReminder = upcomingReminders[0];
    const recentConversation = conversations[0] ?? null;
    stage = 'recentMessages';
    const recentMessages = asArray<Message>(
      recentConversation
        ? await this.repositories.messages.listMessages(recentConversation.id)
        : [],
    );
    const latestMemory = memories[0];
    const voiceConversation = conversations.find((item) => item.channel === 'voice');

    const insights = [
      {
        id: 'mood',
        label: 'Mood today',
        value: capitalize(latestMemory?.mood ?? 'Calm'),
        detail: latestMemory ? `Based on ${latestMemory.title}` : 'Check in with Voxa',
      },
      {
        id: 'call',
        label: 'Last call',
        value: voiceConversation?.lastMessageAt ? 'Recent' : '—',
        detail: voiceConversation?.lastMessageAt
          ? `Voice · ${formatRelativeTime(voiceConversation.lastMessageAt)}`
          : 'No calls yet',
      },
      {
        id: 'goals',
        label: 'Active goals',
        value: String(activeGoals.length),
        detail: activeGoals[0]?.title ?? 'Create a goal with Voxa',
      },
      {
        id: 'memories',
        label: 'Memories',
        value: String(memories.length),
        detail: upcomingReminder
          ? `Next: ${upcomingReminder.title}`
          : `${memories.length} saved locally`,
      },
    ];

    stage = 'wow';
    const wowExperience = buildWowExperience({
      profile,
      bundle,
      homeIntelligence,
      memories,
      goals: activeGoals,
      reminders,
      recentConversation,
      recentMessages,
      insights,
      voiceSessions,
    });

    stage = 'routine';
    const routineSummary = this.storage
      ? await getRoutineCoachService(this.storage, this.repositories).getTodaySchedule(userId)
      : {
          blocks: [],
          completedCount: 0,
          totalCount: 0,
          completionPercent: 0,
          nextBlock: null,
          streakDays: 0,
        };

    const routineMessages = routineProactiveService.generateMessages(profile, routineSummary);
    const routineMessage = routineMessages[0]?.message ?? null;

    const moodHistory = this.storage
      ? await getMoodIntelligenceService(this.storage).getUnifiedMoodHistory(userId)
      : [];
    const journalEntry = this.storage
      ? await getCompanionJournalService(this.storage, this.repositories).getTodayEntry()
      : null;
    const ritualStreaks = this.storage
      ? await getRitualService(this.storage).getStreaks()
      : { morning: 0, evening: 0, combined: 0, reflection: 0, coach: 0 };

    stage = 'phase2';
    const phase2 = buildPhase2Dashboard({
      profile,
      bundle,
      homeIntelligence,
      wowExperience,
      goals: activeGoals,
      memories,
      reminders,
      routine: routineSummary,
      moodHistory,
      journalEntry,
      ritualStreaks,
      routineNudge: routineMessage,
      ritualCoachLine: homeIntelligence.progressUpdate,
      timelineEvents: bundle.lifeTimeline,
    });

    const weeklyGrowth = this.storage
      ? await getWeeklyGrowthService(this.storage, this.repositories).buildGrowthReport(userId)
      : null;

    const phase5Service = this.storage
      ? getPhase5LifeOSService(this.storage, this.repositories)
      : null;
    const linkedLabels = phase5Service
      ? [
          ...(await phase5Service.listBucketItems(userId)).slice(0, 4).map((b) => b.title),
          ...(await phase5Service.listVisionItems(userId)).slice(0, 4).map((v) => v.title),
        ]
      : [];

    stage = 'phase3';
    const phase3 = buildPhase3Dashboard({
      bundle,
      memories,
      goals: activeGoals,
      moodHistory,
      routine: routineSummary,
      weeklyGrowth,
      linkedLabels,
    });

    const lifeOS = this.storage ? await getLifeOSService(this.storage).loadAll(userId) : {
      bucketList: [],
      visionBoard: [],
      futureSelf: [],
      lifeBook: [],
      challenges: [],
    };

    const delightShownIds = this.storage
      ? await getDelightMomentsService(this.storage).loadShownIds()
      : [];

    let bucketCompleted = false;
    let dreamAchieved = false;
    if (phase5Service) {
      const buckets = await phase5Service.listBucketItems(userId);
      bucketCompleted = buckets.some((b) => b.status === 'completed');
      const dreams = await phase5Service.listDreams(userId);
      dreamAchieved = dreams.some((d) => d.summary?.toLowerCase().includes('achieved'));
    }

    stage = 'phase4';
    const phase4 = await buildPhase4Dashboard({
      profile,
      bundle,
      memories,
      goals: activeGoals,
      routine: routineSummary,
      lifeOS,
      journal: journalEntry,
      recentConversations: conversations,
      moodLabel: moodHistory[0]?.label ?? null,
      streakDays: routineSummary.streakDays,
      delightShownIds,
      bucketCompleted,
      dreamAchieved,
    });

    stage = 'phase5';
    const phase5 = phase5Service
      ? await buildPhase5Dashboard({
          userId,
          profile,
          goals: activeGoals,
          memories,
          routine: routineSummary,
          service: phase5Service,
        })
      : {
          goalPlans: 0,
          futureSelfReady: false,
          visionCount: 0,
          bucketCount: 0,
          dreamCount: 0,
          openDecisions: 0,
          coachScore: null,
          memoryConnectionCount: 0,
          latestLifeBookChapter: null,
          storyboardReady: false,
        };

    stage = 'phase6';
    const phase6 = this.storage
      ? await buildPhase6Dashboard({
          userId,
          profile,
          bundle,
          memories,
          goals: activeGoals,
          routine: routineSummary,
          ritualStreaks,
          coachInsight: phase2.dailyCoach.message,
          relationshipMoment: wowExperience.relationshipMoment?.message ?? wowExperience.friendRecallLine ?? null,
          storage: this.storage,
        })
      : {
          proactiveFollowUp: null,
          relationshipProfile: {
            userId,
            daysTogether: 0,
            stage: 'Getting acquainted',
            sharedMemories: 0,
            milestones: [],
            favouriteTopics: [],
            routinesCompleted: 0,
            goalsAchieved: 0,
            ritualsCompleted: 0,
            communicationStyle: 'Warm',
            insideJokes: [],
            learnedSummary: 'Start chatting to build your relationship.',
            framing: 'friend' as const,
            updatedAt: new Date().toISOString(),
          },
          todayFocus: 'One meaningful step today.',
          coachInsight: '',
          relationshipMoment: null,
          sportsStatus: { configured: false, providerName: 'None', cacheHit: false },
          featuredActivities: [],
          presenceGreeting: 'Hello',
          presenceEnergy: 'medium' as const,
          isNightMode: false,
        };

    stage = 'phase7';
    const daysAway = await getDaysSinceLastVisit();
    const phase7 = buildPhase7Dashboard({
      bundle,
      memories,
      goals: activeGoals,
      routine: routineSummary,
      streakDays: routineSummary.streakDays,
      daysAway,
      relationshipScore: Math.min(100, bundle.relationship.sharedMemoryCount * 2 + Math.floor(bundle.relationship.conversationCount / 10)),
      recentConversationPreview: recentMessages[recentMessages.length - 1]?.content ?? null,
      celebrating: !!phase4.delightMoment,
    });

    stage = 'phase8';
    const phase8 = await buildPhase8Dashboard({
      userId,
      bundle,
      memories,
      goals: activeGoals,
      reminders,
      routine: routineSummary,
      streakDays: routineSummary.streakDays,
      daysAway,
      todayFocus: phase6.todayFocus,
      coachQuote: phase2.dailyCoach.message,
      moodHistory: moodHistory.map((m) => ({ label: m.label, date: m.date })),
      celebrating: !!phase4.delightMoment || phase7.livingCompanion.mood === 'celebrating',
      relationshipStage: phase7.relationshipStage,
      storage: this.storage,
    });

    stage = 'phase9';
    const phase9 = await buildPhase9Dashboard({
      userId,
      profile,
      bundle,
      memories,
      goals: activeGoals,
      reminders,
      routine: routineSummary,
      calendar: phase8.calendar,
      todayFocus: phase8.todayFocus,
      moodHistory: moodHistory.map((m) => ({ label: m.label, date: m.date })),
      streakDays: routineSummary.streakDays,
      daysAway,
      recentUserMessage: recentMessages.filter((m) => m.role === 'user').pop()?.content ?? null,
      storage: this.storage,
    });

    stage = 'phase10';
    const phase10 = this.storage
      ? await buildPhase10Dashboard({
          userId,
          goals: activeGoals,
          routine: routineSummary,
          streakDays: routineSummary.streakDays,
          messageCount: bundle.relationship.conversationCount,
          memoryCount: memories.length,
          moodLabel: moodHistory[0]?.label ?? null,
          storage: this.storage,
        })
      : ({
          adventure: {
            headline: 'Your adventure awaits',
            primaryAction: 'challenge',
            primaryLabel: 'View today\'s challenge',
            challenge: null,
            featuredGame: null,
            deckCard: null,
            missionProgress: null,
            missionPercent: 0,
            surprise: null,
            spinAvailable: false,
          },
          dailyChallenge: null,
          weeklyMission: null,
          xp: {
            userId,
            totalXp: 0,
            level: 1,
            xpToNextLevel: 100,
            lifetimeXp: 0,
            updatedAt: nowIso(),
          },
          achievements: [],
          newlyUnlocked: [],
          spin: { date: new Date().toISOString().slice(0, 10), spun: false },
          seasonal: null,
          enjoyment: {
            favouriteGames: [],
            favouriteActivities: [],
            favouriteTopics: [],
            humourPreference: 'medium',
            updatedAt: nowIso(),
          },
          featuredGames: [],
          rewards: [],
          growth: emptyGrowth,
          pendingLevelUp: null,
        } satisfies Phase10DashboardData);

    stage = 'phase11';
    const phase11 = await buildPhase11Dashboard({
      userId,
      profile,
      bundle,
      memories,
      goals: activeGoals,
      routine: routineSummary,
      streakDays: routineSummary.streakDays,
      daysAway,
      todayFocus: phase8.todayFocus ?? phase9.dailyPlan.headline ?? homeIntelligence.dailyFocus,
      moodLabel: moodHistory[0]?.label ?? null,
      celebrating: !!phase4.delightMoment || phase7.livingCompanion.mood === 'celebrating',
      storage: this.storage,
    });

    stage = 'phase12';
    const phase12 = await buildPhase12Dashboard({
      userId,
      profile,
      bundle,
      memories,
      goals: activeGoals,
      routine: routineSummary,
      todayFocus: phase8.todayFocus ?? phase9.dailyPlan.headline ?? homeIntelligence.dailyFocus,
      messageCount: recentMessages.length,
      ritualStreak: ritualStreaks.combined,
      storage: this.storage,
    });

    return {
      profile,
      memories,
      reminders,
      upcomingReminders,
      activeGoals,
      dailyBriefing,
      recentConversation,
      recentMessages,
      insights,
      companionPrompt: homeIntelligence.relationshipMessage.startsWith('"')
        ? homeIntelligence.relationshipMessage
        : `"${homeIntelligence.relationshipMessage}"`,
      companionNote: homeIntelligence.memoryHighlight ?? homeIntelligence.progressUpdate,
      homeIntelligence,
      relationshipSummary: bundle.relationship.summary,
      wowExperience,
      routineSummary,
      routineMessage,
      phase2,
      phase3,
      phase4,
      phase5,
      phase6,
      phase7,
      phase8,
      phase9,
      phase10,
      phase11,
      phase12,
    };
    } catch (err) {
      console.error(
        `[HomeDashboard] build failed at stage=${stage}`,
        err,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }

  async loadChatMessages(conversationId: string) {
    const messages = await this.repositories.messages.listMessages(conversationId);
    return messages
      .filter((item) => item.role !== 'system')
      .map((item) => toChatMessageView(item));
  }

  async getChatExperience(userId: string, conversationId?: string): Promise<ChatExperiencePayload> {
    const dashboard = await this.getHomeDashboard(userId);
    const canvas = conversationId && this.storage
      ? await getConversationCanvasService(this.storage).getCanvas(conversationId)
      : null;

    return {
      contextCards: dashboard.phase4.contextCards,
      smartActions: [],
      canvas,
      livingCompanion: dashboard.phase4.livingCompanion,
      delightMoment: dashboard.phase4.delightMoment,
      personalityMode: dashboard.phase4.personalityMode,
    };
  }

  async executeSmartChatAction(input: {
    userId: string;
    conversationId: string;
    action: SmartChatAction;
    mode: CompanionModeId;
    sourceText?: string;
    messageId?: string;
  }): Promise<{ message: string; success: boolean }> {
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile || !this.storage) {
      return { success: false, message: 'Unable to complete that action right now.' };
    }

    const text = input.action.payload?.text ?? input.sourceText ?? '';
    const lifeOS = getLifeOSService(this.storage);
    const journal = getCompanionJournalService(this.storage, this.repositories);

    switch (input.action.id) {
      case 'remember_this': {
        if (!text.trim()) return { success: false, message: 'Nothing to remember yet.' };
        await this.repositories.memories.createMemory({
          userId: input.userId,
          category: 'moments',
          title: text.slice(0, 48),
          content: text,
          source: 'conversation',
          relatedMode: input.mode,
          importance: 4,
          confidence: 0.8,
        });
        void getRelationshipGrowthService(this.storage!, this.repositories)
          .recordMemoryShared(input.userId)
          .catch(() => undefined);
        return { success: true, message: "I'll remember that." };
      }
      case 'create_goal': {
        const title = text.slice(0, 80) || 'New goal';
        const phase5 = getPhase5LifeOSService(this.storage, this.repositories);
        const { goal } = await phase5.createGoalWithPlan({
          userId: input.userId,
          title,
          description: text,
        });
        return { success: true, message: `Created goal "${goal.title}" with a starter plan. Open Journey to view it.` };
      }
      case 'save_to_journal': {
        if (!text.trim()) return { success: false, message: 'Nothing to save yet.' };
        const today = new Date().toISOString().slice(0, 10);
        const entries = await journal.listEntries();
        const entry = {
          id: `journal-manual-${Date.now()}`,
          date: today,
          body: text,
          isPrivate: false,
          savedAt: new Date().toISOString(),
        };
        await this.storage.setItem(STORAGE_KEYS.companionJournal, [entry, ...entries].slice(0, 30));
        return { success: true, message: 'Saved to your journal.' };
      }
      case 'add_to_bucket_list': {
        const title = text.slice(0, 80) || 'Something to do someday';
        const phase5 = getPhase5LifeOSService(this.storage, this.repositories);
        await phase5.addBucketItem(input.userId, { title, description: text });
        return { success: true, message: `Added "${title}" to your bucket list.` };
      }
      case 'save_to_vision_board': {
        const title = text.slice(0, 80) || 'A dream';
        const phase5 = getPhase5LifeOSService(this.storage, this.repositories);
        await phase5.addVisionItem(input.userId, { title, description: text });
        return { success: true, message: `Added "${title}" to your vision board.` };
      }
      case 'create_challenge': {
        const title = text.slice(0, 60) || 'New challenge';
        await lifeOS.addChallenge(input.userId, title, text);
        return { success: true, message: `Challenge started: ${title}` };
      }
      case 'schedule_reminder':
        return { success: true, message: 'When should I remind you? Say something like "remind me tomorrow at 9am".' };
      case 'break_into_tasks':
      case 'open_canvas':
        return { success: true, message: 'Workspace updated — keep talking and I will map it out.' };
      case 'explain_differently':
        return { success: true, message: 'Say "explain that differently" and I will rephrase.' };
      case 'challenge_thinking':
        return { success: true, message: 'Open Debate Mode from Journey → Life OS to stress-test your idea.' };
      case 'continue_tomorrow':
        return { success: true, message: 'Noted — we can pick this up tomorrow.' };
      case 'favourite_reply': {
        const favourites = (await this.storage.getItem<Record<string, string[]>>(STORAGE_KEYS.favouriteReplies)) ?? {};
        const list = favourites[input.userId] ?? [];
        if (text && !list.includes(text)) {
          favourites[input.userId] = [text, ...list].slice(0, 20);
          await this.storage.setItem(STORAGE_KEYS.favouriteReplies, favourites);
        }
        return { success: true, message: 'Saved as a favourite reply.' };
      }
      case 'pin_memory':
        return { success: true, message: 'Open Journey → Memories to pin something meaningful.' };
      case 'open_debate':
        return { success: true, message: 'Open Journey → Life OS → Debate Mode to challenge this idea.' };
      case 'simulate_decision': {
        const phase5 = getPhase5LifeOSService(this.storage, this.repositories);
        const q = text.slice(0, 200) || 'This decision';
        await phase5.createDecision(input.userId, q);
        return { success: true, message: 'Saved a decision simulation — open Life OS → Decision Simulator to review.' };
      }
      case 'log_dream': {
        const phase5 = getPhase5LifeOSService(this.storage, this.repositories);
        if (!text.trim()) return { success: false, message: 'Describe the dream first.' };
        await phase5.addDream(input.userId, { body: text, isPrivate: true });
        return { success: true, message: 'Dream saved to your private journal.' };
      }
      default:
        return { success: false, message: "I couldn't do that yet." };
    }
  }

  async switchCompanionMode(userId: string, mode: CompanionModeId) {
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile) throw new Error('User profile not found');

    await this.repositories.userProfile.updateProfile({
      companion: { ...profile.companion, lastUsedMode: mode },
    });

    const conversation = await this.getOrCreateConversation(userId, mode, 'chat');
    const existingMessages = await this.repositories.messages.listMessages(conversation.id);

    if (existingMessages.length === 0) {
      const modeConfig = getCompanionMode(mode);
      await this.repositories.messages.createMessage({
        conversationId: conversation.id,
        role: 'voxa',
        content: modeConfig.openingMessage,
        mode,
      });
      await this.repositories.conversations.updateConversation(conversation.id, {
        lastMessageAt: nowIso(),
      });
    }

    return {
      mode: getCompanionMode(mode),
      conversation,
    };
  }

  async listMemories(userId: string) {
    return this.repositories.memories.listMemories(userId);
  }

  async deleteMemory(memoryId: string) {
    await this.repositories.memories.deleteMemory(memoryId);
  }

  async clearAllMemories(userId: string) {
    await this.repositories.memories.clearMemoriesForUser(userId);
  }

  async listTrustedContacts(userId: string): Promise<TrustedContact[]> {
    return this.repositories.trustedContacts.listContacts(userId);
  }

  async createGoal(input: CreateGoalInput, options?: { linkCheckIn?: boolean }): Promise<CreateGoalResult> {
    const profile = await this.repositories.userProfile.getProfile();
    if (profile && this.billing) {
      const ctx = await this.getBillingContext(input.userId, profile);
      if (ctx) await this.assertGate(this.billing.featureGate.canCreateGoal(ctx.planStatus, ctx.usage));
    }

    let goal = await this.repositories.goals.createGoal(input);
    let linkedReminder: Reminder | undefined;

    if (options?.linkCheckIn) {
      const scheduledAt = new Date();
      scheduledAt.setDate(scheduledAt.getDate() + 1);
      scheduledAt.setHours(9, 0, 0, 0);

      linkedReminder = await this.repositories.reminders.createReminder({
        userId: input.userId,
        kind: 'daily_goal',
        title: `Check-in: ${goal.title}`,
        body: goal.description,
        scheduledAt: scheduledAt.toISOString(),
        recurrence: 'daily',
        mode: 'coach',
        goalId: goal.id,
      });

      try {
        const { notificationService } = await import('./notifications/notification-service');
        const notificationId = await notificationService.scheduleReminderFromEntity(linkedReminder);
        linkedReminder = await this.repositories.reminders.updateReminder(linkedReminder.id, {
          notificationId,
        });
      } catch {
        // Reminder persists without OS notification if permission denied.
      }

      goal = await this.repositories.goals.updateGoal(goal.id, {
        linkedReminderId: linkedReminder.id,
      });
    }

    return { goal, linkedReminder };
  }

  async listActiveGoals(userId: string) {
    return this.repositories.goals.listActiveGoals(userId);
  }

  async activateVoiceSession(sessionId: string): Promise<VoiceSession> {
    return this.repositories.voiceSessions.updateSession(sessionId, {
      state: 'active',
      startedAt: nowIso(),
    });
  }

  async endVoiceSession(sessionId: string, durationSeconds: number): Promise<VoiceSession> {
    const session = await this.repositories.voiceSessions.getSession(sessionId);
    const ended = await this.repositories.voiceSessions.updateSession(sessionId, {
      state: 'ended',
      endedAt: nowIso(),
      durationSeconds,
    });

    if (session && this.billing && durationSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
      await this.billing.usageTracking.recordVoiceMinute(session.userId, minutes);
      await this.billing.subscription.refreshUsageCounts(session.userId, this.repositories);
    }

    if (session && this.storage && durationSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
      void getRelationshipGrowthService(this.storage, this.repositories)
        .recordVoiceMinutes(session.userId, minutes)
        .catch(() => undefined);
    }

    return ended;
  }

  async getActiveVoiceSession(userId: string) {
    return this.repositories.voiceSessions.getActiveSession(userId);
  }

  async sendChatMessage(
    input: SendChatMessageInput,
    options?: SendChatMessageOptions,
  ): Promise<SendChatMessageResult> {
    const sendStarted = talkPerfNow();
    const profileStarted = talkPerfNow();
    const profile =
      input.loadedProfile && input.loadedProfile.id === input.userId
        ? input.loadedProfile
        : await this.repositories.userProfile.getProfile();
    if (!profile) throw new Error('User profile required before sending messages.');
    talkPerf('profile', talkPerfNow() - profileStarted);

    const hasAttachments = Boolean(input.attachments?.length);
    if (!input.content.trim() && !hasAttachments) {
      throw new Error('Message cannot be empty.');
    }

    if (!isBillingDormant() && this.billing) {
      const billingStarted = talkPerfNow();
      const billingCtx = await this.getBillingContext(input.userId, profile);
      if (billingCtx) {
        if (hasAttachments) {
          for (const attachment of input.attachments!) {
            if (attachment.type === 'image') {
              await this.assertGate(this.billing.featureGate.canUploadImage(billingCtx.planStatus, billingCtx.usage));
            }
            if (attachment.type === 'video') {
              await this.assertGate(this.billing.featureGate.canUploadVideo(billingCtx.planStatus, billingCtx.usage));
            }
            if (attachment.type === 'audio') {
              await this.assertGate(this.billing.featureGate.canUseVoiceNote(billingCtx.planStatus, billingCtx.usage));
            }
            if (attachment.type === 'file') {
              await this.assertGate(this.billing.featureGate.canUploadDocument(billingCtx.planStatus, billingCtx.usage));
            }
          }
        }
        await this.assertGate(this.billing.featureGate.canUseAiChat(billingCtx.planStatus, billingCtx.usage));
      }
      talkPerf('billingGate', talkPerfNow() - billingStarted);
    }

    let effectiveUserText = input.content.trim();
    let attachments: MessageAttachment[] | undefined;
    let mediaSource: MemorySource = 'text';
    let imageUrlForVision: string | undefined;
    let imageAnalysisSummary: string | undefined;

    if (hasAttachments) {
      const processor = createAttachmentProcessor(this.ai);
      const processed = await processor.processPending(input.attachments!, input.content);
      attachments = processed.attachments;
      effectiveUserText = processed.effectiveUserText;
      mediaSource = processed.mediaSource;
      imageUrlForVision = processed.imageUrlForVision;
      imageAnalysisSummary = processed.imageAnalysisSummary;
    }

    const displayContent =
      input.content.trim() ||
      (attachments?.length ? attachmentDisplayLabel(attachments[0]) : '');

    const persistUserStarted = talkPerfNow();
    const seedHistory = input.recentHistory ?? [];
    const talkIntentEarly = classifyTalkIntent(effectiveUserText, seedHistory);
    const previousAssistantText = [...seedHistory].reverse().find((item) => item.role === 'voxa')?.content;
    let livePlan = resolveLiveInformationPlan({
      userMessage: effectiveUserText,
      previousAssistantText,
    });
    if (livePlan.kind === 'weather' && this.storage) {
      const hasSavedWeatherLocation = await getWeatherService(this.storage).hasSavedLocation();
      livePlan = resolveLiveInformationPlan({
        userMessage: effectiveUserText,
        previousAssistantText,
        hasSavedWeatherLocation,
      });
    }
    let liveSearch = livePlan.liveSearch;
    logFeature(
      'live.information',
      'start',
      `LIVE_KIND=${livePlan.kind} LIVE_SEARCH_ROUTE=${liveSearch} ASK_CITY=${livePlan.askForWeatherCity}`,
    );
    const isFactualFastPath = talkIntentEarly.intent === 'factual_question';
    const goalsPromise = isFactualFastPath
      ? Promise.resolve([] as Goal[])
      : this.repositories.goals.listActiveGoals(input.userId);
    const remindersPromise = isFactualFastPath
      ? Promise.resolve([] as Reminder[])
      : this.repositories.reminders.listReminders(input.userId);

    const userDraft =
      input.existingUserMessage ??
      buildLocalTalkMessage({
        id: createId('msg'),
        conversationId: input.conversationId,
        role: 'user',
        content: displayContent,
        mode: input.mode,
        attachments,
      });
    if (input.existingUserMessage) {
      await this.repositories.messages.updateMessage(userDraft.id, { status: 'pending' }).catch(() => undefined);
    } else {
      await this.repositories.messages.upsertMessage(userDraft);
    }
    talkPerf('persist-user', talkPerfNow() - persistUserStarted);
    const persistUserRemote = input.existingUserMessage
      ? Promise.resolve(userDraft)
      : this.persistTalkMessageRemote(userDraft);
    let userMessage = userDraft;

    if (livePlan.askForWeatherCity) {
      const voxaMessage = buildLocalTalkMessage({
        id: createId('msg'),
        conversationId: input.conversationId,
        role: 'voxa',
        content: WEATHER_ASK_CITY_USER_LINE,
        mode: input.mode,
      });
      await this.repositories.messages.upsertMessage(voxaMessage);
      await this.repositories.messages.updateMessage(userMessage.id, { status: 'sent' }).catch(() => undefined);
      options?.onAssistantReady?.({ userMessage, voxaMessage });
      void persistUserRemote.catch(() => undefined);
      void this.persistTalkMessageRemote(voxaMessage).catch(() => undefined);
      void this.repositories.conversations
        .updateConversation(input.conversationId, { lastMessageAt: voxaMessage.createdAt })
        .catch(() => undefined);
      logFeature('live.information', 'success', 'LIVE_KIND=weather LIVE_SEARCH_ROUTE=false ASK_CITY=true');
      return { userMessage, voxaMessage };
    }

    if (!hasAttachments && parseDistanceQuestion(effectiveUserText)) {
      const lookup = await lookupStraightLineDistance(effectiveUserText);
      const voxaMessage = buildLocalTalkMessage({
        id: createId('msg'),
        conversationId: input.conversationId,
        role: 'voxa',
        content: lookup.ok ? formatVerifiedDistanceReply(lookup) : DISTANCE_UNVERIFIED_LINE,
        mode: input.mode,
      });
      await this.repositories.messages.upsertMessage(voxaMessage);
      await this.repositories.messages.updateMessage(userMessage.id, { status: 'sent' }).catch(() => undefined);
      options?.onAssistantReady?.({ userMessage, voxaMessage });
      void persistUserRemote.catch(() => undefined);
      void this.persistTalkMessageRemote(voxaMessage).catch(() => undefined);
      void this.repositories.conversations
        .updateConversation(input.conversationId, { lastMessageAt: voxaMessage.createdAt })
        .catch(() => undefined);
      return { userMessage, voxaMessage };
    }

    if (this.storage) {
      void getProactiveCheckInOrchestrator(this.storage, this.repositories)
        .recordActivity(input.userId)
        .catch(() => undefined);
    }

    if (this.storage) {
      void getMoodIntelligenceService(this.storage).detectAndRecord({
        userId: input.userId,
        text: effectiveUserText,
        source: 'conversation',
      });
    }

    if (attachments?.length) {
      const pendingAttachments = attachments;
      void persistUserRemote
        .then(async (persisted) => {
          const processor = createAttachmentProcessor(this.ai);
          const uploaded = await processor.uploadAll({
            userId: input.userId,
            conversationId: input.conversationId,
            messageId: persisted.id,
            attachments: pendingAttachments,
          });
          await this.repositories.messages.updateMessage(persisted.id, { attachments: uploaded });
        })
        .catch((err) => {
          console.warn('[Voxa] Background attachment upload failed.', err);
        });
    }

    if (!hasAttachments && !isFactualFastPath && parseMusicIntent(input.content)) {
      const voxaMessage = await this.repositories.messages.createMessage({
        conversationId: input.conversationId,
        role: 'voxa',
        content:
          "Open Music in Settings to identify songs, or ask me about an artist once you've recognised a track.",
        mode: input.mode,
      });
      await this.repositories.conversations.updateConversation(input.conversationId, {
        lastMessageAt: voxaMessage.createdAt,
      });
      options?.onAssistantReady?.({ userMessage, voxaMessage });
      return { userMessage, voxaMessage };
    }

    if (!hasAttachments && !isFactualFastPath && this.storage) {
      const phase5 = getPhase5LifeOSService(this.storage, this.repositories);
      const talkResult = await phase5.handleTalkCommand(input.userId, effectiveUserText);
      if (talkResult.handled) {
        const voxaMessage = await this.repositories.messages.createMessage({
          conversationId: input.conversationId,
          role: 'voxa',
          content: talkResult.reply,
          mode: input.mode,
        });
        await this.repositories.conversations.updateConversation(input.conversationId, {
          lastMessageAt: voxaMessage.createdAt,
        });
        options?.onAssistantReady?.({ userMessage, voxaMessage });
        return { userMessage, voxaMessage };
      }
    }

    const [activeGoalsForParse, remindersForParse] = await Promise.all([goalsPromise, remindersPromise]);
    const upcomingForParse = getUpcomingReminders(remindersForParse, 5);

    const parsedIntent = await this.chatActions.parseMessage(effectiveUserText, {
      userProfile: profile,
      mode: input.mode,
      activeGoals: activeGoalsForParse,
      upcomingReminders: upcomingForParse,
    });
    if (parsedIntent) {
      const actionResult = await this.chatActions.execute(parsedIntent, {
        userId: input.userId,
        mode: input.mode,
        conversationId: input.conversationId,
      });

      const replyConversationId =
        actionResult.sideEffect?.type === 'switch_mode'
          ? actionResult.sideEffect.conversationId
          : input.conversationId;

      const replyMode =
        actionResult.sideEffect?.type === 'switch_mode'
          ? actionResult.sideEffect.mode
          : input.mode;

      const voxaMessage = await this.repositories.messages.createMessage({
        conversationId: replyConversationId,
        role: 'voxa',
        content: actionResult.confirmationMessage,
        mode: replyMode,
        metadata: { executedAction: parsedIntent.action },
      });

      await this.repositories.conversations.updateConversation(replyConversationId, {
        lastMessageAt: voxaMessage.createdAt,
      });

      if (parsedIntent.action === 'switch_mode') {
        await this.repositories.userProfile.updateProfile({
          companion: { ...profile.companion, lastUsedMode: replyMode },
        });
      }

      await this.companionIntelligence.afterConversation({
        userId: input.userId,
        userProfile: profile,
        userMessage: effectiveUserText,
        voxaReply: voxaMessage.content,
        mode: replyMode,
      });

      options?.onAssistantReady?.({ userMessage, voxaMessage });
      return {
        userMessage,
        voxaMessage,
        executedAction: parsedIntent.action,
        sideEffect: actionResult.sideEffect,
      };
    }

    const historyStarted = talkPerfNow();
    const history =
      input.recentHistory !== undefined
        ? [...seedHistory.filter((item) => item.id !== userMessage.id), userMessage]
        : await this.repositories.messages.listMessages(input.conversationId);
    const moodHistory =
      isFactualFastPath || !this.storage
        ? []
        : await getMoodIntelligenceService(this.storage).getUnifiedMoodHistory(input.userId);
    talkPerf('history', talkPerfNow() - historyStarted);
    const talkIntentResult = classifyTalkIntent(effectiveUserText, history);
    imageUrlForVision = resolveImageUrlForVision({
      currentTurnUri: imageUrlForVision,
      userMessage: effectiveUserText,
      history,
    });

    if (profile.preferences.memoryEnabled) {
      await this.memoryEngine.handleUserMemoryCommand(input.userId, effectiveUserText);
    }

    const contextStarted = talkPerfNow();
    const unifiedContext = await this.companionIntelligence.buildContext({
      userId: input.userId,
      userProfile: profile,
      mode: input.mode,
      conversationId: input.conversationId,
      userMessage: effectiveUserText,
      moodHistory,
      talkIntent: talkIntentResult.intent,
      skipMemoryRetrieval: talkIntentSkipsMemoryRetrieval(talkIntentResult.intent) || liveSearch || livePlan.kind !== 'none',
    });
    talkPerf('memory', talkPerfNow() - contextStarted);
    const effectiveMode = unifiedContext.mode;
    const memories =
      livePlan.kind !== 'none' || liveSearch || !profile.preferences.memoryEnabled ? [] : unifiedContext.topMemories;
    const activeGoals = activeGoalsForParse;
    const allReminders = remindersForParse;
    const selectedContextModules = selectContextModules(talkIntentResult.intent, effectiveUserText);
    if (livePlan.kind === 'weather' && !selectedContextModules.includes('weather')) {
      selectedContextModules.push('weather');
    }
    const wants = (module: ContextModule) => selectedContextModules.includes(module);

    const extrasStarted = talkPerfNow();
    const storage = this.storage;
    const [
      studioPrefsStored,
      growthSnapshot,
      futureConv,
      preferenceMemories,
      challenge,
      stylePrefs,
      routineSummary,
      intelligenceBundle,
      moodBlock,
      morningCheckIn,
      eveningCheckIn,
      weatherBlock,
      nutritionBlock,
      notesBlock,
      faithBlock,
    ] = storage
      ? await Promise.all([
          wants('phase7_personality')
            ? storage.getItem<CompanionStudioExtendedPrefs>(STORAGE_KEYS.companionStudioPrefs)
            : Promise.resolve(null),
          wants('phase7_personality')
            ? getRelationshipGrowthService(storage, this.repositories).getSnapshot(input.userId)
            : Promise.resolve(null),
          wants('phase8_focused')
            ? getFutureConversationsService(storage).getDueToday(input.userId)
            : Promise.resolve(null),
          wants('phase8_focused')
            ? getPreferenceMemoryService(storage).list(input.userId)
            : Promise.resolve([]),
          wants('phase8_focused')
            ? getSharedChallengesService(storage).getActive(input.userId)
            : Promise.resolve(null),
          getConversationStyleMemoryService(storage).get(input.userId),
          wants('phase11_dashboard')
            ? getRoutineCoachService(storage, this.repositories).getTodaySchedule(input.userId)
            : Promise.resolve(null),
          wants('phase11_dashboard')
            ? this.companionIntelligence.getBundle(input.userId, profile.displayName)
            : Promise.resolve(null),
          wants('mood')
            ? getMoodIntelligenceService(storage).buildAdaptationBlock(input.userId, effectiveUserText)
            : Promise.resolve(''),
          wants('check_in')
            ? getDailyCheckInService(storage).getTodayEntry('morning')
            : Promise.resolve(null),
          wants('check_in')
            ? getDailyCheckInService(storage).getTodayEntry('evening')
            : Promise.resolve(null),
          wants('weather')
            ? buildWeatherPromptBlock(getWeatherService(storage), effectiveUserText, {
                placeQuery: livePlan.weatherPlaceQuery,
              })
            : Promise.resolve(''),
          wants('nutrition')
            ? (async () => {
                const nutrition = getNutritionService(storage);
                const prefs = await nutrition.getPreferences(input.userId);
                if (prefs.mode === 'off') return '';
                const todaySummary = await nutrition.getTodaySummary(input.userId);
                return nutrition.buildNutritionPromptBlock(prefs, todaySummary);
              })()
            : Promise.resolve(''),
          wants('notes')
            ? (async () => {
                const { formatNotesForPrompt, listNotesForConversationContext } = await import(
                  './notes/notes-context-service'
                );
                const permitted = await listNotesForConversationContext(storage, input.userId, 3);
                return formatNotesForPrompt(permitted);
              })()
            : Promise.resolve(''),
          wants('faith')
            ? (async () => {
                const { buildFaithValuesPromptBlockFromService } = await import(
                  './faith/faith-values-context-service'
                );
                const { getFaithValuesService } = await import('./faith/faith-values-service');
                return buildFaithValuesPromptBlockFromService(getFaithValuesService(storage), input.userId);
              })()
            : Promise.resolve(''),
        ])
      : [
          null,
          null,
          null,
          [],
          null,
          undefined,
          null,
          null,
          '',
          null,
          null,
          '',
          '',
          '',
          '',
        ];
    talkPerf('context', talkPerfNow() - extrasStarted);

    const studioPrefs = studioPrefsStored ?? createDefaultStudioExtendedPrefs();
    const goalsCompleted = unifiedContext.relationship.goalsAchievedTogether;
    const daysTogether = Math.max(
      1,
      Math.floor((Date.now() - new Date(unifiedContext.relationship.relationshipStartedAt).getTime()) / 86400000),
    );
    let relStage = resolveFriendshipLevel({
      daysTogether,
      conversationCount: unifiedContext.relationship.conversationCount,
      sharedMemories: unifiedContext.relationship.sharedMemoryCount,
      goalsCompleted,
    });
    let friendshipLine = FRIENDSHIP_LEVEL_LABELS[relStage];
    if (growthSnapshot) {
      relStage = growthSnapshot.level;
      friendshipLine = `${growthSnapshot.levelLabel} — ${growthSnapshot.familiarityLine}`;
    }
    const phase7Block = wants('phase7_personality')
      ? buildPhase7PromptExtension(
          `${stagePromptBlock(relStage)}\n## Friendship\n${friendshipLine}`,
          buildStudioExtendedPromptBlock(studioPrefs),
        )
      : '';

    let phase8Block = wants('phase8_focused') ? buildPhase8PromptExtension() : '';
    if (wants('phase8_focused') && storage) {
      const calendar = buildLifeCalendar({ reminders: allReminders, memories, goals: activeGoals });
      const focusedBlock = buildFocusedContextBlock({
        context: unifiedContext,
        userMessage: effectiveUserText,
        calendarLine: calendar.todayLine ?? calendar.tomorrowLine,
        futureLine: futureConv?.resumeLine ?? null,
        preferenceBlock: getPreferenceMemoryService(storage).formatForPrompt(preferenceMemories),
        challengeTitle: challenge?.title ?? null,
        relationshipStage: relStage,
        todayFocus: calendar.todayLine ?? activeGoals[0]?.title ?? null,
      });
      if (focusedBlock) phase8Block = buildPhase8PromptExtension(focusedBlock);
    }

    const recentVoxaTexts = history.filter((m) => m.role === 'voxa').slice(-3).map((m) => m.content);

    const companionStrategy = buildCompanionStrategy({
      talkIntent: talkIntentResult,
      userMessage: effectiveUserText,
      history,
      memories,
      stylePrefs,
      recentVoxaReplies: recentVoxaTexts,
    });

    const turnPlanStarted = talkPerfNow();
    const turnPlan = buildTurnIntelligencePlan({
      userMessage: effectiveUserText,
      selectedMode: input.mode,
      strategy: companionStrategy,
      userProfile: profile,
      stylePrefs,
      relationship: {
        conversationCount: unifiedContext.relationship.conversationCount,
        daysTogether,
      },
      memories,
      history,
      recentVoxaReplies: recentVoxaTexts,
    });
    talkPerf('turn-plan', talkPerfNow() - turnPlanStarted);

    const responsePlan = planResponse({
      userMessage: effectiveUserText,
      memories,
      goals: activeGoals,
      stylePrefs,
      recentVoxaReplies: recentVoxaTexts,
      moodTrend: moodHistory[0]?.label ?? null,
      strategy: companionStrategy,
      turnPlan,
    });

    if (storage) {
      void getConversationStyleMemoryService(storage).updateFromMessage(input.userId, effectiveUserText);
    }

    const phase9Block = buildPhase9PromptExtension(
      'Follow the Turn intelligence block placed after Safety. It is authoritative for this reply.',
    );

    let phase11Block = '';
    if (wants('phase11_dashboard') && storage && routineSummary && intelligenceBundle) {
      const phase11Dash = await buildPhase11Dashboard({
        userId: input.userId,
        profile,
        bundle: intelligenceBundle,
        memories,
        goals: activeGoals,
        routine: routineSummary,
        streakDays: routineSummary.streakDays,
        daysAway: 0,
        todayFocus: activeGoals[0]?.title ?? 'Today',
        moodLabel: moodHistory[0]?.label ?? null,
        celebrating: /passed|got it|finally|nailed|i did it/i.test(effectiveUserText),
        storage,
      });
      phase11Block = buildPhase11PromptExtension(
        buildPhase11PromptForChat({
          dashboard: phase11Dash,
          stage: relStage,
          styleHints: styleHintsFromPrefs(stylePrefs),
        }),
      );
    }

    let checkInBlock = '';
    const entry =
      eveningCheckIn && !eveningCheckIn.skipped
        ? eveningCheckIn
        : morningCheckIn && !morningCheckIn.skipped
          ? morningCheckIn
          : null;
    if (entry) {
      checkInBlock = buildTodayCheckInPromptBlock({
        period: entry.period,
        moodLabel: entry.answers.mood ?? entry.mood,
      });
    }

    let journalBlock = '';
    if (storage && (wants('journal') || wants('reflection'))) {
      const journalTalk = await loadJournalTalkContext({
        storage,
        repositories: this.repositories,
        userId: input.userId,
        userMessage: effectiveUserText,
        intent: talkIntentResult.intent,
        timeZone: profile.timezone,
        memories,
      });
      journalBlock = journalTalk.block;
    }

    const wantsChallenge =
      /challenge (my|me)|stress-?test|push back respectfully|challenge my thinking/i.test(
        effectiveUserText,
      );
    const challengeBlock = wantsChallenge ? buildChallengeMePromptExtension(effectiveUserText) : '';

    const reflectionBlock = '';

    let weatherContext = weatherBlock;
    if (livePlan.kind === 'weather') {
      liveSearch = !weatherPromptIsGrounded(weatherContext);
      if (liveSearch) {
        weatherContext = '';
        logFeature('live.information', 'start', 'LIVE_KIND=weather LIVE_SEARCH_ROUTE=true WEATHER_FALLBACK=true');
      }
    }

    const companionContextExtension = assembleRoutedContextExtension(selectedContextModules, {
      companion_core: this.companionIntelligence.getPromptExtension(unifiedContext, { includeMemories: false }),
      phase4_quality: buildPhase4PromptExtension(),
      phase7_personality: phase7Block,
      phase8_focused: phase8Block,
      phase9_plan: phase9Block,
      phase11_dashboard: phase11Block,
      mood: moodBlock,
      check_in: checkInBlock,
      challenge: challengeBlock,
      reflection: reflectionBlock,
      journal: journalBlock,
      weather: weatherContext,
      nutrition: nutritionBlock,
      notes: notesBlock,
      faith: faithBlock,
    });
    const upcomingReminders = getUpcomingReminders(allReminders, 5);

    const aiInput = {
      mode: effectiveMode,
      userMessage: imageUrlForVision
        ? stripVisionPlaceholdersFromUserText(effectiveUserText) || input.content.trim()
        : effectiveUserText,
      conversationHistory: history,
      userProfile: profile,
      memories,
      goals: activeGoals,
      upcomingReminders,
      currentTime: unifiedContext.currentTime,
      companionContextExtension,
      turnIntelligenceBlock: turnPlan.promptBlock,
      talkIntent: talkIntentResult.intent,
      referencesRecentTurns: talkIntentResult.referencesRecentTurns,
      conversationState: turnPlan.state,
      contextModules: selectedContextModules,
      imageUrlForVision,
      imageAnalysisSummary: imageUrlForVision || liveSearch ? undefined : imageAnalysisSummary,
      liveSearch,
      liveSearchLocationLabel: livePlan.weatherPlaceQuery,
    };

    logCompanionStrategyDiagnostic({
      strategy: companionStrategy,
      contextModules: selectedContextModules,
      memoryCount: memories.length,
    });

    let aiResult: GenerateReplyResult;
    const gatewayStarted = talkPerfNow();
    const publishChunk = options?.onStreamChunk
      ? (chunk: string) => {
          let next = sanitizeTalkDisplayText(chunk, { timeZone: profile.timezone });
          if (liveSearch) next = shapeLivePublicAnswer(effectiveUserText, next);
          options.onStreamChunk!(next);
        }
      : undefined;
    if (publishChunk && isStreamCapableAI(this.ai)) {
      aiResult = await this.ai.generateReplyStream(aiInput, publishChunk);
    } else {
      aiResult = await this.ai.generateReply(aiInput);
      if (publishChunk) {
        publishChunk(aiResult.content);
      }
    }
    talkPerf('gateway', talkPerfNow() - gatewayStarted);

    let replyContent = sanitizeTalkDisplayText(aiResult.content, { timeZone: profile.timezone });
    if (liveSearch) {
      replyContent = shapeLivePublicAnswer(effectiveUserText, replyContent);
    }
    const quality = scoreResponseQuality(replyContent, responsePlan, recentVoxaTexts, companionStrategy);
    if (!quality.passed) {
      replyContent = polishResponse(replyContent, quality.issues);
    }

    const persistReplyStarted = talkPerfNow();
    const voxaMessage = buildLocalTalkMessage({
      id: createId('msg'),
      conversationId: input.conversationId,
      role: 'voxa',
      content: replyContent,
      mode: effectiveMode,
      metadata: aiResult.sourceLine ? { sourceLine: aiResult.sourceLine } : undefined,
    });
    await this.repositories.messages.upsertMessage(voxaMessage);
    await this.repositories.messages.updateMessage(userMessage.id, { status: 'sent' }).catch(() => undefined);
    talkPerf('persist-reply', talkPerfNow() - persistReplyStarted);
    options?.onAssistantReady?.({ userMessage, voxaMessage });

    void persistUserRemote.catch(() => undefined);
    void this.persistTalkMessageRemote(voxaMessage).catch(() => undefined);
    void this.repositories.conversations
      .updateConversation(input.conversationId, {
        lastMessageAt: voxaMessage.createdAt,
      })
      .catch(() => undefined);

    void this.repositories.userProfile.updateProfile({
      companion: { ...profile.companion, lastUsedMode: effectiveMode },
    }).catch(() => undefined);

    void this.memoryEngine.processAfterReply({
      userId: input.userId,
      userMessage: effectiveUserText,
      voxaReply: voxaMessage.content,
      mode: effectiveMode,
      userProfile: profile,
      mediaSource: hasAttachments ? mediaSource : undefined,
    }).catch((err) => {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[Voxa] Background memory extraction failed.', err);
      }
    });

    void this.companionIntelligence.afterConversation({
      userId: input.userId,
      userProfile: profile,
      userMessage: effectiveUserText,
      voxaReply: voxaMessage.content,
      mode: effectiveMode,
    }).catch((err) => {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[Voxa] Background personality update failed.', err);
      }
    });

    if (this.storage) {
      void getFutureConversationsService(this.storage)
        .schedule({ userId: input.userId, conversationId: input.conversationId, userMessage: effectiveUserText })
        .catch(() => undefined);
      void getWorkspaceSessionsService(this.storage)
        .upsertFromExchange({
          userId: input.userId,
          conversationId: input.conversationId,
          userMessage: effectiveUserText,
          voxaReply: voxaMessage.content,
        })
        .catch(() => undefined);
      void getPreferenceMemoryService(this.storage)
        .ingestFromMessage(input.userId, effectiveUserText)
        .catch(() => undefined);
      void getFutureConversationsService(this.storage)
        .getDueToday(input.userId)
        .then((dueFuture) => {
          if (dueFuture && dueFuture.conversationId === input.conversationId) {
            return getFutureConversationsService(this.storage!).resolve(input.userId, dueFuture.id);
          }
          return undefined;
        })
        .catch(() => undefined);
    }

    void this.maybeSummarizeConversation({
      conversationId: input.conversationId,
      profile,
      mode: effectiveMode,
      messages: [...history, userMessage, voxaMessage],
      activeGoals,
      upcomingReminders,
    });

    if (!isBillingDormant() && this.billing) {
      void (async () => {
        await this.billing!.usageTracking.recordAiMessage(input.userId);
        if (hasAttachments) {
          for (const attachment of input.attachments!) {
            if (attachment.type === 'image') await this.billing!.usageTracking.recordImageUpload(input.userId);
            if (attachment.type === 'video') await this.billing!.usageTracking.recordVideoUpload(input.userId);
            if (attachment.type === 'audio') await this.billing!.usageTracking.recordVoiceNote(input.userId);
            if (attachment.type === 'file') await this.billing!.usageTracking.recordDocument(input.userId);
          }
        }
        await this.billing!.subscription.refreshUsageCounts(input.userId, this.repositories);
      })().catch(() => undefined);
    }

    const bundle = intelligenceBundle;
    const signals = bundle ? modeInferenceEngine.inferSignals(effectiveUserText, bundle) : null;
    const personalityMode: ChatExperiencePayload['personalityMode'] =
      (bundle && signals
        ? personalityV3Service.inferModeFromMessage(effectiveUserText, signals, bundle)
        : unifiedContext.adaptiveModeLabel) ?? 'friend';
    if (this.storage) {
      void getConversationCanvasService(this.storage)
        .updateFromExchange({
          conversationId: input.conversationId,
          userMessage: effectiveUserText,
          voxaReply: voxaMessage.content,
        })
        .catch(() => undefined);
    }
    const smartActions = smartChatActionsService.suggest({
      userMessage: effectiveUserText,
      voxaReply: voxaMessage.content,
      mode: effectiveMode,
      isLargeTopic: false,
      emotional: Boolean(signals?.needsSupport),
      goalMentioned: /goal/i.test(effectiveUserText),
    });
    const chatExperience: ChatExperiencePayload = {
      contextCards: [],
      smartActions,
      canvas: null,
      livingCompanion: {
        greeting: '',
        subline: '',
        mood: 'calm',
        energy: 'medium',
        conversationStarter: '',
        thinkingAbout: null,
        daySignature: '',
      },
      delightMoment: null,
      personalityMode,
    };

    if (this.storage && effectiveUserText.trim().length >= 12) {
      void getFollowUpEngineService(this.storage)
        .detectFromMessage(input.userId, effectiveUserText)
        .catch(() => undefined);
    }

    const phase9Suggestions = buildContextualSuggestions({
      talkIntent: talkIntentResult.intent,
      userMessage: effectiveUserText,
      voxaReply: voxaMessage.content,
      strategy: companionStrategy.state,
      stance: turnPlan.stance,
      humourSuppressed: turnPlan.humourSuppressed,
      questionPolicy: turnPlan.questionPolicy,
    });

    if (this.storage && effectiveUserText.trim().length >= 4) {
      void getXpService(this.storage).award(input.userId, 5, 'chat').catch(() => undefined);
    }

    const richReply = parseRichResponse(
      voxaMessage.content,
      memories.slice(0, 8).map((m) => m.title),
    );

    talkPerf('post-response', 0);
    talkPerf('total', talkPerfNow() - sendStarted);
    return {
      userMessage,
      voxaMessage,
      aiMeta: aiResult,
      adaptiveModeLabel: unifiedContext.adaptiveModeLabel,
      chatExperience,
      richReply,
      phase9Suggestions,
    };
  }

  /** Remote insert using the same id as the local row. Failures keep the local copy. */
  private async persistTalkMessageRemote(message: Message): Promise<Message> {
    try {
      return await this.repositories.messages.createMessage({
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        mode: message.mode,
        status: message.status,
        metadata: message.metadata,
        attachments: message.attachments,
      });
    } catch {
      return message;
    }
  }

  async retryMessageAttachmentUpload(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    attachmentId: string;
  }): Promise<Message> {
    const messages = await this.repositories.messages.listMessages(input.conversationId);
    const message = messages.find((item) => item.id === input.messageId);
    if (!message?.attachments?.length) {
      throw new Error('Message not found.');
    }

    const attachment = message.attachments.find((item) => item.id === input.attachmentId);
    if (!attachment) {
      throw new Error('Attachment not found.');
    }

    const uploaded = await attachmentStorageService.uploadAttachment({
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      attachment: { ...attachment, uploadStatus: 'uploading' },
    });

    const nextAttachments = message.attachments.map((item) =>
      item.id === attachment.id ? uploaded : item,
    );
    return this.repositories.messages.updateMessage(message.id, { attachments: nextAttachments });
  }

  async deleteReminder(reminderId: string): Promise<void> {
    const reminder = await this.repositories.reminders.getReminder(reminderId);
    if (reminder?.notificationId) {
      await import('./notifications/notification-service').then(({ notificationService }) =>
        notificationService.cancelNotification(reminder.notificationId!),
      );
    }
    await this.repositories.reminders.deleteReminder(reminderId);
  }

  private async maybeSummarizeConversation(input: {
    conversationId: string;
    profile: UserProfile;
    mode: CompanionModeId;
    messages: Message[];
    activeGoals: Goal[];
    upcomingReminders: Reminder[];
  }) {
    const nonSystem = input.messages.filter((item) => item.role !== 'system');
    if (nonSystem.length < 8 || nonSystem.length % 8 !== 0) return;

    try {
      const summary = await this.ai.summarizeConversation({
        userProfile: input.profile,
        mode: input.mode,
        messages: input.messages,
        goals: input.activeGoals,
        upcomingReminders: input.upcomingReminders,
        currentTime: new Date().toISOString(),
      });
      await this.repositories.conversations.updateConversation(input.conversationId, { summary });
    } catch (error) {
      console.warn('[Voxa] Conversation summary skipped.', error);
    }
  }

  async startVoiceSession(userId: string, mode: CompanionModeId = 'friend'): Promise<SessionStartResult> {
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile) throw new Error('User profile not found');

    const billingCtx = await this.getBillingContext(userId, profile);
    if (billingCtx && this.billing) {
      await this.assertGate(this.billing.featureGate.canUseVoice(billingCtx.planStatus, billingCtx.usage));
    }

    const conversation = await this.getOrCreateConversation(userId, mode, 'voice', 'Voice call');
    const voiceSession = await this.repositories.voiceSessions.createSession({
      userId,
      conversationId: conversation.id,
      mode,
      isSafeCall: false,
    });

    const history = await this.repositories.messages.listMessages(conversation.id);
    const modeConfig = getCompanionMode(mode);
    const memories = profile.preferences.memoryEnabled
      ? await this.memoryEngine.retrieveForPrompt(userId, {
          userMessage: 'Starting a voice call with Voxa.',
          mode,
          recentMessageTexts: history.map((item) => item.content),
        })
      : [];

    let openingContent = modeConfig.openingMessage;
    try {
      const aiResult = await this.ai.generateReply({
        mode,
        userMessage: 'Starting a voice call with Voxa.',
        conversationHistory: history,
        userProfile: profile,
        memories,
      });
      openingContent = aiResult.content;
    } catch {
      openingContent = modeConfig.openingMessage;
    }

    const openingMessage = await this.repositories.messages.createMessage({
      conversationId: conversation.id,
      role: 'voxa',
      content: openingContent,
      mode,
      metadata: { channel: 'voice' },
    });

    const activeSession = await this.repositories.voiceSessions.updateSession(voiceSession.id, {
      state: 'active',
      startedAt: nowIso(),
      transcriptMessageIds: [openingMessage.id],
    });

    await this.repositories.conversations.updateConversation(conversation.id, {
      lastMessageAt: openingMessage.createdAt,
    });

    await this.memoryEngine.processAfterReply({
      userId,
      userMessage: 'Starting a voice call with Voxa.',
      voxaReply: openingMessage.content,
      mode,
      userProfile: profile,
    });

    return { conversation, openingMessage, voiceSession: activeSession };
  }

  async startSafeCallSession(userId: string): Promise<SessionStartResult> {
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile) throw new Error('User profile not found');

    const billingCtx = await this.getBillingContext(userId, profile);
    if (billingCtx && this.billing) {
      await this.assertGate(this.billing.featureGate.canUseVoice(billingCtx.planStatus, billingCtx.usage));
    }

    const conversation = await this.repositories.conversations.createConversation({
      userId,
      mode: 'safe_call',
      channel: 'safe_call',
      title: 'Safe Call session',
    });

    const voiceSession = await this.repositories.voiceSessions.createSession({
      userId,
      conversationId: conversation.id,
      mode: 'safe_call',
      isSafeCall: true,
      checkInIntervalMinutes: 30,
    });

    const modeConfig = getCompanionMode('safe_call');
    const memories = profile.preferences.memoryEnabled
      ? await this.memoryEngine.retrieveForPrompt(userId, {
          userMessage: 'I need to start a safe call.',
          mode: 'safe_call',
        })
      : [];

    let openingContent = `${modeConfig.openingMessage} ${VOXA_SAFETY.notEmergency}`;
    try {
      const aiResult = await this.ai.generateReply({
        mode: 'safe_call',
        userMessage: 'I need to start a safe call.',
        conversationHistory: [],
        userProfile: profile,
        memories,
      });
      openingContent = `${aiResult.content} ${VOXA_SAFETY.notEmergency}`;
    } catch {
      openingContent = `${modeConfig.openingMessage} ${VOXA_SAFETY.notEmergency}`;
    }

    const openingMessage = await this.repositories.messages.createMessage({
      conversationId: conversation.id,
      role: 'voxa',
      content: openingContent,
      mode: 'safe_call',
      metadata: { channel: 'safe_call', isSafeCall: true },
    });

    const activeSession = await this.repositories.voiceSessions.updateSession(voiceSession.id, {
      state: 'active',
      startedAt: nowIso(),
      transcriptMessageIds: [openingMessage.id],
    });

    await this.repositories.conversations.updateConversation(conversation.id, {
      lastMessageAt: openingMessage.createdAt,
    });

    await this.memoryEngine.processAfterReply({
      userId,
      userMessage: 'I need to start a safe call.',
      voxaReply: openingMessage.content,
      mode: 'safe_call',
      userProfile: profile,
    });

    return { conversation, openingMessage, voiceSession: activeSession };
  }

  async createScheduledReminder(input: CreateReminderInput): Promise<CreateReminderResult> {
    const profile = await this.repositories.userProfile.getProfile();
    if (profile && this.billing) {
      const ctx = await this.getBillingContext(input.userId, profile);
      if (ctx) await this.assertGate(this.billing.featureGate.canCreateReminder(ctx.planStatus, ctx.usage));
    }

    const reminder = await this.repositories.reminders.createReminder(input);
    const { scheduleLocalReminderIfAllowed, reminderScheduleConfirmation } = await import(
      './notifications/schedule-local-reminder'
    );
    const scheduled = await scheduleLocalReminderIfAllowed(reminder);
    const saved =
      scheduled.ok
        ? await this.repositories.reminders.updateReminder(reminder.id, {
            notificationId: scheduled.notificationId,
          })
        : reminder;
    const when = formatReminderTime(saved.scheduledAt);
    const talkCopy = reminderScheduleConfirmation({
      title: saved.title,
      when,
      scheduled,
    });

    return {
      reminder: saved,
      confirmationMessage: scheduled.ok ? buildVoxaCheckInConfirmation(saved) : talkCopy.confirmationMessage,
    };
  }

  async afterVoiceTurn(input: {
    userId: string;
    userMessage: string;
    voxaReply: string;
    mode: CompanionModeId;
  }): Promise<void> {
    if (!input.userId) return;
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile) return;
    await this.companionIntelligence.afterConversation({
      userId: input.userId,
      userProfile: profile,
      userMessage: input.userMessage,
      voxaReply: input.voxaReply,
      mode: input.mode,
    });
  }

  async buildVoiceIntelligenceExtension(input: {
    userId: string;
    conversationId: string;
    userMessage: string;
    mode: CompanionModeId;
  }): Promise<string> {
    const profile = await this.repositories.userProfile.getProfile();
    if (!profile) return '';

    if (this.storage) {
      void getMoodIntelligenceService(this.storage).detectAndRecord({
        userId: input.userId,
        text: input.userMessage,
        source: 'voice',
      });
    }

    const moodHistory = this.storage
      ? await getMoodIntelligenceService(this.storage).getUnifiedMoodHistory(input.userId)
      : [];

    const unifiedContext = await this.companionIntelligence.buildContext({
      userId: input.userId,
      userProfile: profile,
      mode: input.mode,
      conversationId: input.conversationId,
      userMessage: input.userMessage,
      moodHistory,
    });

    const moodBlock = this.storage
      ? await getMoodIntelligenceService(this.storage).buildAdaptationBlock(input.userId, input.userMessage)
      : '';

    const { buildHumanStyleExtension } = await import('./personality/human-response-style');
    return `${this.companionIntelligence.getPromptExtension(unifiedContext)}\n\n${buildHumanStyleExtension(true)}${moodBlock ? `\n\n${moodBlock}` : ''}`;
  }

  async refreshUsageCounts(userId: string) {
    if (!this.billing) return;
    await this.billing.subscription.refreshUsageCounts(userId, this.repositories);
  }

  async listUpcomingReminders(userId: string, limit = 5): Promise<Reminder[]> {
    const reminders = await this.repositories.reminders.listReminders(userId);
    return getUpcomingReminders(reminders, limit);
  }
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

type StreamCapableAI = IAIService & {
  generateReplyStream: (
    input: import('./contracts').GenerateReplyInput,
    onChunk: (chunk: string) => void,
  ) => Promise<GenerateReplyResult>;
};

function isStreamCapableAI(ai: IAIService): ai is StreamCapableAI {
  return typeof (ai as StreamCapableAI).generateReplyStream === 'function';
}

function formatRelativeTime(isoDate: string) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}
