import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { hasSupabaseConfig } from '../config/env';
import { isBillingDormant } from '../config/launch-mode';
import { recordSyncFailure, recordSyncSuccess } from '../utils/debug-info';
import { authService } from '../services/auth/auth-service';
import { createBackgroundServices, BackgroundServices } from '../services/background/background-services';
import {
  clearAllLocalVoxaData,
  getVoxaServices,
  resetVoxaServices,
  seedLocalVoxaData,
  VoxaCompanionService,
  VoxaServices,
} from '../services';
import { UserProfile } from '../types';
import { validateBillingEnvironment } from '../services/billing/billing-validation';
import { BillingLog } from '../services/billing/billing-logger';
import { hasRevenueCatConfig } from '../config/revenuecat-env';
import { friendlyErrorMessage } from '../utils/friendly-error';
import { resetTransientSessionState } from '../services/session/reset-transient-session-state';

const FOREGROUND_ENTITLEMENT_REFRESH_MIN_MS = 5_000;

type VoxaContextValue = {
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  profile: UserProfile | null;
  services: VoxaServices;
  companion: VoxaCompanionService;
  background: BackgroundServices;
  refreshProfile: () => Promise<void>;
  reinitialize: () => Promise<void>;
  resetLocalData: () => Promise<void>;
  signOutCleanup: () => Promise<void>;
};

const VoxaContext = createContext<VoxaContextValue | null>(null);

export function VoxaProvider({ children }: { children: ReactNode }) {
  const [services, setServices] = useState(() => getVoxaServices());
  const background = useMemo(() => createBackgroundServices(services.repositories, services.storage), [services]);
  const companion = useMemo(
    () =>
      new VoxaCompanionService(
        services.repositories,
        services.ai,
        services.memoryEngine,
        services.companionIntelligence,
        {
          subscription: services.subscription,
          featureGate: services.featureGate,
          usageTracking: services.usageTracking,
        },
        services.storage,
      ),
    [services],
  );
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const presentedUiRef = useRef(false);

  const initialize = useCallback(async () => {
    if (!presentedUiRef.current) {
      setIsLoading(true);
    }
    setError(null);

    try {
      if (hasSupabaseConfig()) {
        const authUser = await authService.getAuthUser();
        const cachedProfile = await services.repositories.userProfile.getProfile();
        if (authUser && cachedProfile && cachedProfile.id !== authUser.id) {
          console.warn('[Voxa] Stale local profile cache detected — clearing before cloud sync.');
          await services.billingService.signOut(cachedProfile.id);
          await clearAllLocalVoxaData(services.storage);
        }
      }

      let currentProfile = await services.repositories.userProfile.getProfile();

      if (!currentProfile && hasSupabaseConfig()) {
        const authUser = await authService.getAuthUser();
        if (authUser) {
          currentProfile = await services.repositories.userProfile.createProfile({
            displayName: authUser.displayName,
            email: authUser.email,
          });
        }
      }

      if (!currentProfile && !hasSupabaseConfig()) {
        currentProfile = await seedLocalVoxaData(services.repositories);
      }

      if (!currentProfile) {
        throw new Error('User profile not found. Please sign in again.');
      }

      if (!isBillingDormant()) {
        const billingValidation = validateBillingEnvironment();
        if (!hasRevenueCatConfig()) {
          if (__DEV__) {
            console.info('[Voxa Billing] Billing unavailable in this development build.');
          }
        } else if (!billingValidation.allRequiredOk) {
          const failedLabels = billingValidation.checks.filter((check) => !check.ok).map((check) => check.label);
          BillingLog.configureFailure(`Startup billing validation: ${failedLabels.join(', ')}`);
          if (__DEV__) {
            console.warn('[Voxa Billing] Validation incomplete — continuing with free access.', failedLabels);
          }
        } else {
          BillingLog.configureSuccess();
        }

        try {
          await services.subscription.syncProfile(currentProfile);
        } catch (billingErr) {
          if (__DEV__) {
            console.error('[Voxa Billing] syncProfile failed (non-blocking)', billingErr);
          }
        }
      }

      try {
        await services.subscription.refreshUsageCounts(currentProfile.id, services.repositories);
      } catch (usageErr) {
        if (__DEV__) {
          console.warn('[Voxa Billing] refreshUsageCounts failed (non-blocking)', usageErr);
        }
      }

      const syncedProfile = await services.repositories.userProfile.getProfile();

      setProfile(syncedProfile ?? currentProfile);
      setIsReady(true);
      presentedUiRef.current = true;
      recordSyncSuccess();

      if (currentProfile.onboardingComplete) {
        void background.runStartupTasks(currentProfile.id, syncedProfile ?? currentProfile).catch((startupErr) => {
          if (__DEV__) console.warn('[Voxa] Startup tasks failed (non-blocking)', startupErr);
        });
      }
    } catch (err) {
      const profileMissing =
        err instanceof Error && err.message === 'User profile not found. Please sign in again.';
      setError(
        profileMissing
          ? err.message
          : friendlyErrorMessage(err, 'Unable to start Voxa. Check your connection and try again.'),
      );
      setIsReady(false);
      recordSyncFailure();
    } finally {
      setIsLoading(false);
    }
  }, [services.repositories, services.storage, background]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  const lastForegroundRefreshAt = useRef(0);

  useEffect(() => {
    if (!isReady || !profile?.id || isBillingDormant()) return;

    const refreshEntitlements = () => {
      const now = Date.now();
      if (now - lastForegroundRefreshAt.current < FOREGROUND_ENTITLEMENT_REFRESH_MIN_MS) return;
      lastForegroundRefreshAt.current = now;
      void services.billingService
        .refreshOnForeground(profile.id)
        .then((entitlement) => {
          BillingLog.foregroundRefresh(entitlement.isPro);
        })
        .catch(() => {
          // Offline / store unavailable — keep last known normalized entitlement.
        });
    };

    const onAppState = (state: AppStateStatus) => {
      if (state === 'active') refreshEntitlements();
    };

    const sub = AppState.addEventListener('change', onAppState);
    return () => sub.remove();
  }, [isReady, profile?.id, services.billingService]);

  const refreshProfile = useCallback(async () => {
    const nextProfile = await services.repositories.userProfile.getProfile();
    setProfile(nextProfile);
  }, [services.repositories.userProfile]);

  const reinitialize = useCallback(async () => {
    await initialize();
  }, [initialize]);

  const resetLocalData = useCallback(async () => {
    if (hasSupabaseConfig()) return;
    setIsLoading(true);
    setError(null);
    try {
      await clearAllLocalVoxaData(services.storage);
      const freshServices = resetVoxaServices({ forceLocal: true });
      setServices(freshServices);
      const seededProfile = await seedLocalVoxaData(freshServices.repositories);
      setProfile(seededProfile);
      setIsReady(true);
    } catch (err) {
      setError(friendlyErrorMessage(err, 'Could not reset local data. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }, [services.storage]);

  const signOutCleanup = useCallback(async () => {
    presentedUiRef.current = false;
    setIsLoading(true);
    setIsReady(false);
    resetTransientSessionState();
    try {
      if (profile?.id) {
        await services.billingService.signOut(profile.id);
      }
      if (hasSupabaseConfig()) {
        await clearAllLocalVoxaData(services.storage);
      }
    } catch (err) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('[Voxa] Failed to clear local cache on sign out.', err);
      }
    }
    resetVoxaServices();
    setServices(getVoxaServices());
    setProfile(null);
    setIsReady(false);
    setError(null);
  }, [services.storage, services.subscription, profile?.id]);

  const value = useMemo(
    () => ({
      isReady,
      isLoading,
      error,
      profile,
      services,
      companion,
      background,
      refreshProfile,
      reinitialize,
      resetLocalData,
      signOutCleanup,
    }),
    [
      isReady,
      isLoading,
      error,
      profile,
      services,
      companion,
      background,
      refreshProfile,
      reinitialize,
      resetLocalData,
      signOutCleanup,
    ],
  );

  return <VoxaContext.Provider value={value}>{children}</VoxaContext.Provider>;
}

export function useVoxa() {
  const context = useContext(VoxaContext);
  if (!context) {
    throw new Error('useVoxa must be used within VoxaProvider');
  }
  return context;
}
