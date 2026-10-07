import {
  CompanionModeId,
  Conversation,
  CreateConversationInput,
  CreateGoalInput,
  CreateMemoryInput,
  CreateMessageInput,
  CreateReminderInput,
  CreateTrustedContactInput,
  CreateUserProfileInput,
  CreateVoiceSessionInput,
  Goal,
  Memory,
  Message,
  Reminder,
  TrustedContact,
  UpdateConversationInput,
  UpdateGoalInput,
  UpdateMemoryInput,
  UpdateReminderInput,
  UpdateUserProfileInput,
  UpdateVoiceSessionInput,
  UserProfile,
  VoiceSession,
} from '../../types';

export interface IUserProfileRepository {
  getProfile(): Promise<UserProfile | null>;
  saveProfile(profile: UserProfile): Promise<UserProfile>;
  createProfile(input: CreateUserProfileInput): Promise<UserProfile>;
  updateProfile(input: UpdateUserProfileInput): Promise<UserProfile>;
  clearProfile(): Promise<void>;
}

export interface IMemoryRepository {
  listMemories(userId: string): Promise<Memory[]>;
  getMemory(id: string): Promise<Memory | null>;
  createMemory(input: CreateMemoryInput): Promise<Memory>;
  updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  clearMemoriesForUser(userId: string): Promise<void>;
}

export interface IConversationRepository {
  listConversations(userId: string): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  updateConversation(id: string, input: UpdateConversationInput): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
}

export interface IMessageRepository {
  listMessages(conversationId: string): Promise<Message[]>;
  createMessage(input: CreateMessageInput): Promise<Message>;
  upsertMessage(message: Message): Promise<Message>;
  updateMessage(id: string, input: import('../../types').UpdateMessageInput): Promise<Message>;
  deleteMessagesForConversation(conversationId: string): Promise<void>;
  deleteMessage(id: string): Promise<void>;
}

export interface IReminderRepository {
  listReminders(userId: string): Promise<Reminder[]>;
  listUpcomingCheckIns(userId: string): Promise<Reminder[]>;
  getReminder(id: string): Promise<Reminder | null>;
  createReminder(input: CreateReminderInput): Promise<Reminder>;
  updateReminder(id: string, input: UpdateReminderInput): Promise<Reminder>;
  deleteReminder(id: string): Promise<void>;
}

export interface IGoalRepository {
  listGoals(userId: string): Promise<Goal[]>;
  listActiveGoals(userId: string): Promise<Goal[]>;
  getGoal(id: string): Promise<Goal | null>;
  createGoal(input: CreateGoalInput): Promise<Goal>;
  updateGoal(id: string, input: UpdateGoalInput): Promise<Goal>;
  deleteGoal(id: string): Promise<void>;
}

export interface IVoiceSessionRepository {
  listSessions(userId: string): Promise<VoiceSession[]>;
  getActiveSession(userId: string): Promise<VoiceSession | null>;
  getSession(id: string): Promise<VoiceSession | null>;
  createSession(input: CreateVoiceSessionInput): Promise<VoiceSession>;
  updateSession(id: string, input: UpdateVoiceSessionInput): Promise<VoiceSession>;
}

export interface ITrustedContactRepository {
  listContacts(userId: string): Promise<TrustedContact[]>;
  createContact(input: CreateTrustedContactInput): Promise<TrustedContact>;
}

export type GenerateReplyInput = {
  mode: CompanionModeId;
  userMessage: string;
  conversationHistory: Message[];
  userProfile: UserProfile;
  memories: Memory[];
  goals?: Goal[];
  upcomingReminders?: Reminder[];
  currentTime?: string;
  companionContextExtension?: string;
  /**
   * Authoritative turn plan. Must be placed after Safety in the system prompt
   * and must never live only inside the truncatable context extension.
   */
  turnIntelligenceBlock?: string;
  talkIntent?: import('../ai/companion-intent').TalkIntent;
  referencesRecentTurns?: boolean;
  conversationState?: import('../ai/companion-strategy').ConversationState;
  contextModules?: string[];
  /** Base64 data URL or remote URL for vision. */
  imageUrlForVision?: string;
  /** True when this turn needs hosted web search on the gateway. */
  liveSearch?: boolean;
  /** Named city from the user question — never a guessed location. */
  liveSearchLocationLabel?: string;
  imageAnalysisSummary?: string;
};

export type GenerateCheckInInput = {
  mode: CompanionModeId;
  userProfile: UserProfile;
  reminder: Reminder;
  memories: Memory[];
};

export type GenerateReplyResult = {
  content: string;
  sourceLine?: string;
  suggestedMemory?: Pick<CreateMemoryInput, 'category' | 'title' | 'content' | 'mood' | 'relatedMode'>;
};

export type ExtractedMemoryCandidate = Pick<
  CreateMemoryInput,
  'category' | 'title' | 'content' | 'mood' | 'importance' | 'tags' | 'relatedMode'
>;

export type AnalyzeConversationInput = {
  userMessage: string;
  voxaReply: string;
  mode: CompanionModeId;
  userProfile: UserProfile;
  existingMemories: Memory[];
  mediaSource?: import('../../types').MemorySource;
};

export type SummarizeConversationInput = {
  userProfile: UserProfile;
  mode: CompanionModeId;
  messages: Message[];
  goals?: Goal[];
  upcomingReminders?: Reminder[];
  currentTime?: string;
};

export type UnderstandActionIntentInput = {
  message: string;
  userProfile: UserProfile;
  mode: CompanionModeId;
  activeGoals?: Goal[];
  upcomingReminders?: Reminder[];
  currentTime?: string;
};

/** Structured action intent returned by AI understanding (mapped to chat actions). */
export type AIActionIntentResult =
  | {
      action: 'set_reminder';
      title: string;
      scheduledAt: string;
    }
  | {
      action: 'create_goal';
      title: string;
      category: import('../../types').GoalCategory;
    }
  | {
      action: 'none';
    };

/**
 * AI companion contract.
 * Replace FakeAIService with an OpenAI-backed implementation later.
 */
export interface IAIService {
  generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult>;
  generateCheckInPrompt(input: GenerateCheckInInput): Promise<string>;
  generateConversationTitle(mode: CompanionModeId, firstMessage: string): Promise<string>;
  extractMemoriesFromExchange(input: AnalyzeConversationInput): Promise<ExtractedMemoryCandidate[]>;
  understandActionIntent(input: UnderstandActionIntentInput): Promise<AIActionIntentResult>;
  summarizeConversation(input: SummarizeConversationInput): Promise<string>;
  transcribeAudio(input: { uri: string; fileName?: string }): Promise<string | null>;
  analyzeImage(input: { uri: string; mimeType?: string }): Promise<string | null>;
}

export type VoxaRepositories = {
  userProfile: IUserProfileRepository;
  memories: IMemoryRepository;
  conversations: IConversationRepository;
  messages: IMessageRepository;
  reminders: IReminderRepository;
  goals: IGoalRepository;
  voiceSessions: IVoiceSessionRepository;
  trustedContacts: ITrustedContactRepository;
};

export type VoxaServices = {
  storage: import('./storage-service').IStorageService;
  ai: IAIService;
  repositories: VoxaRepositories;
  memoryEngine: import('../memory/memory-intelligence-service').MemoryIntelligenceService;
  companionIntelligence: import('../intelligence/companion-intelligence-service').CompanionIntelligenceService;
  usageTracking: import('../billing/usage-tracking-service').UsageTrackingService;
  subscriptionRepo: import('../billing/billing-contracts').ISubscriptionRepository;
  billing: import('../billing/billing-contracts').IBillingService;
  /** Canonical RevenueCat billing facade — prefer over `billing` / raw SDK. */
  billingService: import('../billing/billing-service').BillingService;
  purchaseManager: import('../billing/billing-contracts').IPurchaseManager;
  subscription: import('../billing/subscription-service').SubscriptionService;
  featureGate: import('../billing/feature-gate-service').FeatureGateService;
  entitlementService: import('../billing/subscription-entitlement-service').SubscriptionEntitlementService;
  entitlementAccess: import('../billing/entitlement-access-service').EntitlementAccessService;
  subscriptionAnalytics: import('../billing/subscription-analytics-service').SubscriptionAnalyticsService;
  paywallImpressions: import('../billing/paywall-impression-service').PaywallImpressionService;
  modelRouting: import('../billing/model-routing-service').ModelRoutingService;
  synchroniser: import('../billing/revenuecat-subscription-synchroniser').RevenueCatSubscriptionSynchroniser;
};

export type { IStorageService } from './storage-service';
