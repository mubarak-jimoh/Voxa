import { createAppAIService } from './ai/create-ai-service';
import {
  IAIService,
  IStorageService,
  IUserProfileRepository,
  VoxaRepositories,
  VoxaServices,
} from './contracts';
import { AsyncStorageService } from './local/async-storage-service';
import { LocalConversationRepository } from './local/local-conversation-repository';
import { LocalMemoryRepository } from './local/local-memory-repository';
import { LocalMessageRepository } from './local/local-message-repository';
import { LocalReminderRepository } from './local/local-reminder-repository';
import { LocalUserProfileRepository } from './local/local-user-profile-repository';
import { LocalGoalRepository } from './local/local-goal-repository';
import { LocalTrustedContactRepository } from './local/local-trusted-contact-repository';
import { createCompanionIntelligenceService } from './intelligence/companion-intelligence-service';
import { MemoryIntelligenceService } from './memory/memory-intelligence-service';
import { LocalVoiceSessionRepository } from './local/local-voice-session-repository';
import { hasSupabaseConfig } from '../config/env';
import { getSupabaseClient } from './supabase/client';
import { createHybridRepositories } from './hybrid/hybrid-repositories';
import { createSupabaseRepositories } from './supabase/supabase-repositories';
import {
  FeatureGateService,
  LocalSubscriptionRepository,
  SubscriptionService,
  UsageTrackingService,
} from './billing';
import { createMusicRecognitionService } from './music/music-recognition-service';
import { IBillingService, ISubscriptionRepository } from './billing/billing-contracts';
import { RevenueCatPurchaseManager } from './billing/revenuecat-purchase-manager';
import { RevenueCatBillingService } from './billing/revenuecat-billing-service';
import { RevenueCatSubscriptionSynchroniser } from './billing/revenuecat-subscription-synchroniser';
import { SubscriptionEntitlementService } from './billing/subscription-entitlement-service';
import { SubscriptionAnalyticsService } from './billing/subscription-analytics-service';
import { PaywallImpressionService } from './billing/paywall-impression-service';
import { ModelRoutingService } from './billing/model-routing-service';
import { BillingService } from './billing/billing-service';
import { EntitlementAccessService } from './billing/entitlement-access-service';
import { resetRoutineCoachService } from './routine/routine-coach-service';
import { resetCompanionJournalService } from './journal/companion-journal-service';
import { resetNutritionService } from './nutrition/nutrition-service';
import { resetNotesServiceForTests } from './notes/notes-service';
import { resetPhotoMemoryServiceForTests } from './phase12/photo-memory-service';

export type CreateVoxaServicesOptions = {
  storage?: IStorageService;
  ai?: IAIService;
  /** Force local repositories even when Supabase is configured. */
  forceLocal?: boolean;
  /** Use Supabase only (no local cache fallback). Default false when Supabase is configured. */
  supabaseOnly?: boolean;
};

export function createVoxaServices(options: CreateVoxaServicesOptions = {}): VoxaServices {
  const storage = options.storage ?? new AsyncStorageService();
  const ai = options.ai ?? createAppAIService();

  const localRepositories: VoxaRepositories = {
    userProfile: new LocalUserProfileRepository(storage),
    memories: new LocalMemoryRepository(storage),
    conversations: new LocalConversationRepository(storage),
    messages: new LocalMessageRepository(storage),
    reminders: new LocalReminderRepository(storage),
    goals: new LocalGoalRepository(storage),
    voiceSessions: new LocalVoiceSessionRepository(storage),
    trustedContacts: new LocalTrustedContactRepository(storage),
  };

  const repositories: VoxaRepositories =
    hasSupabaseConfig() && !options.forceLocal
      ? options.supabaseOnly
        ? createSupabaseRepositories(getSupabaseClient())
        : createHybridRepositories(getSupabaseClient(), storage)
      : localRepositories;

  const memoryEngine = new MemoryIntelligenceService(repositories.memories, ai);
  const companionIntelligence = createCompanionIntelligenceService(repositories, storage, memoryEngine);

  const usageTracking = new UsageTrackingService(storage);
  const subscriptionRepo: ISubscriptionRepository = new LocalSubscriptionRepository(
    repositories.userProfile,
    usageTracking,
  );
  const entitlementService = new SubscriptionEntitlementService(storage);
  const purchaseManager = new RevenueCatPurchaseManager(entitlementService);
  const synchroniser = new RevenueCatSubscriptionSynchroniser(
    subscriptionRepo,
    entitlementService,
    purchaseManager,
  );
  purchaseManager.setCustomerInfoEntitlementHandler((userId, entitlement) => {
    void synchroniser.syncFromCustomerInfo(userId, entitlement);
  });
  const billing: IBillingService = new RevenueCatBillingService(
    purchaseManager,
    synchroniser,
    entitlementService,
    subscriptionRepo,
  );
  const subscription = new SubscriptionService(
    subscriptionRepo,
    billing,
    usageTracking,
    entitlementService,
    storage,
  );
  const billingService = new BillingService(
    billing,
    subscription,
    entitlementService,
    synchroniser,
    purchaseManager,
  );
  const featureGate = new FeatureGateService();
  const subscriptionAnalytics = new SubscriptionAnalyticsService(storage);
  const paywallImpressions = new PaywallImpressionService(storage);
  const entitlementAccess = new EntitlementAccessService(
    subscription,
    featureGate,
    paywallImpressions,
  );
  const modelRouting = new ModelRoutingService();
  createMusicRecognitionService(storage);

  return {
    storage,
    ai,
    repositories,
    memoryEngine,
    companionIntelligence,
    usageTracking,
    subscriptionRepo,
    billing,
    billingService,
    purchaseManager,
    subscription,
    featureGate,
    entitlementService,
    entitlementAccess,
    subscriptionAnalytics,
    paywallImpressions,
    modelRouting,
    synchroniser,
  };
}

/** Singleton for app-wide access until a React context/provider is added. */
let voxaServicesSingleton: VoxaServices | null = null;

export function getVoxaServices(): VoxaServices {
  if (!voxaServicesSingleton) {
    voxaServicesSingleton = createVoxaServices();
  }
  return voxaServicesSingleton;
}

export function resetVoxaServices(options: CreateVoxaServicesOptions = {}): VoxaServices {
  resetRoutineCoachService();
  resetCompanionJournalService();
  resetNutritionService();
  resetNotesServiceForTests();
  resetPhotoMemoryServiceForTests();
  voxaServicesSingleton = createVoxaServices(options);
  return voxaServicesSingleton;
}

export type { IUserProfileRepository, VoxaRepositories, VoxaServices };
