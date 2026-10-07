import { CompositeScreenProps, useFocusEffect } from '@react-navigation/native';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { isFeatureVisible } from '../config/feature-status';
import { FadeIn, EmptyState, StaggerFade } from '../components/premium/premium-ui';
import { BootLoadingScreen } from '../components/ui/boot-loading-screen';
import { HomeHeroSection } from '../components/phase6/home-hero-section';
import { HomeMorningBriefCard } from '../components/home/home-morning-brief-card';
import { ScreenShell } from '../components/ui/screen-shell';
import { VoxaText } from '../components/ui/voxa-text';
import { TodayQuickActions } from '../components/home/today-quick-actions';
import { UpcomingScheduledCallCard } from '../components/home/upcoming-scheduled-call-card';
import { NutritionHomeSummary } from '../components/nutrition/nutrition-home-summary';
import { isScheduledCallsEnabled } from '../config/scheduled-calls';
import { isRealtimeVoiceEnabled } from '../config/realtime-voice';
import { DelightBanner } from '../components/phase7/delight-banner';
import { TodaysAdventureCard } from '../components/phase10/todays-adventure-card';
import { colors, layout, radius, spacing } from '../constants/theme';
import { useVoxa } from '../context/voxa-context';
import { useCachedDashboard, invalidateDashboardCache } from '../hooks/use-cached-dashboard';
import { MainTabParamList, RootStackParamList } from '../navigation/types';
import {
  buildCompanionGreeting,
  CompanionGreeting,
  getDaysSinceLastVisit,
  getLastGreetingKey,
  recordCompanionVisit,
  rememberLastGreeting,
  syncCompanionFocusFromSignals,
} from '../services/companion/companion-presence-service';
import { getDailyCheckInService } from '../services/check-in/daily-check-in-service';
import { CHALLENGE_ME_STARTER } from '../services/chat/challenge-me-prompt';
import { getCompanionFocusState } from '../services/companion/companion-focus-state';
import { getDelightMomentsService } from '../services/intelligence/delight-moments-service';
import { getConversationMilestonesService } from '../services/phase8/conversation-milestones-service';
import { getDailySurpriseService } from '../services/phase10/daily-surprise-service';
import { getCelebrationService, buildLevelUpMessage } from '../services/phase10/celebration-service';
import { getFollowUpEngineService } from '../services/phase11/follow-up-engine-service';
import { getLivingWowService } from '../services/phase11/living-wow-service';
import { getWeatherService } from '../services/weather/weather-service';
import { trackEvent } from '../services/analytics/analytics-service';
import { getVoxaAvatarTint, getVoxaDisplayName } from '../utils/companion-display';
import { formatHomeHeroSublineFromRaw } from '../utils/home-hero-copy';
import { hapticCelebrate, hapticLight } from '../utils/haptics';
import { getRitualService } from '../services/ritual/ritual-service';
import { getDailyReflectionService } from '../services/reflection/daily-reflection-service';
import { getScheduledCallService } from '../services/scheduled-calls/scheduled-call-service';
import { ScheduledCompanionCall } from '../types/scheduled-companion-call';
import { navigateToRoutine } from '../utils/home-navigation';
import { FRIENDLY_ERRORS, friendlyErrorMessage } from '../utils/friendly-error';
import { RitualHomeState } from '../types/ritual';
import { WeatherBundle } from '../types/weather';
import { recordTiming } from '../utils/performance-metrics';
import { STORAGE_KEYS } from '../constants/storage-keys';
import {
  CompanionStudioExtendedPrefs,
  createDefaultStudioExtendedPrefs,
} from '../constants/companion-studio-extended';
import { FaithValuesHomeCard } from '../components/faith/faith-values-home-card';
import { CommandBarSheet } from '../components/life-os/command-bar-sheet';
import { handleCommandBarResult } from '../utils/command-bar-navigation';
import { getFaithValuesService } from '../services/faith/faith-values-service';
import { getRoutineCoachService } from '../services/routine/routine-coach-service';
import { FaithValuesMode } from '../types/faith-values';

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Home'>,
  NativeStackScreenProps<RootStackParamList>
>;

export function HomeScreen({ navigation }: Props) {
  const { profile, companion, services } = useVoxa();

  const fetchDashboard = useCallback(
    (userId: string) => companion.getHomeDashboard(userId),
    [companion],
  );

  const { dashboard, isLoading, load, invalidate } = useCachedDashboard(profile?.id, fetchDashboard);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ritualState, setRitualState] = useState<RitualHomeState | null>(null);
  const [dismissedDelight, setDismissedDelight] = useState(false);
  const [dismissedMilestone, setDismissedMilestone] = useState(false);
  const [reflectionPending, setReflectionPending] = useState(false);
  const [weatherBundle, setWeatherBundle] = useState<WeatherBundle | null>(null);
  const [presence, setPresence] = useState<CompanionGreeting | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [upcomingCall, setUpcomingCall] = useState<ScheduledCompanionCall | null>(null);
  const [faithHome, setFaithHome] = useState<{
    mode: FaithValuesMode;
    hasIntention: boolean;
  } | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!profile) return;
      setLoadError(null);
      trackEvent('home_opened');
      const started = Date.now();
      void (async () => {
        let dash: Awaited<ReturnType<typeof load>> = null;
        try {
          dash = await load();
        } catch (err) {
          console.error(
            '[Home] Dashboard load failed',
            err,
            err instanceof Error ? err.stack : undefined,
          );
          setLoadError(friendlyErrorMessage(err, FRIENDLY_ERRORS.home));
          recordTiming('home.warm', Date.now() - started);
          return;
        }

        try {
          const secondary = await Promise.allSettled([
            isFeatureVisible('weather')
              ? getWeatherService(services.storage).fetchForecast()
              : Promise.resolve(null),
            getDaysSinceLastVisit(),
            isFeatureVisible('dailyCheckIn')
              ? getRitualService(services.storage).getHomeState()
              : Promise.resolve(null),
            getRoutineCoachService(services.storage, services.repositories)
              .getTodaySchedule(profile.id)
              .catch(() => null),
            services.storage.getItem<CompanionStudioExtendedPrefs>(STORAGE_KEYS.companionStudioPrefs),
            getCompanionFocusState(profile.id),
            (async () => {
              const hour = new Date().getHours();
              if (hour < 17) return false;
              const todayReflection = await getDailyReflectionService(services.storage).getToday(profile.id);
              return !todayReflection?.answers.smiled.trim();
            })(),
            isScheduledCallsEnabled()
              ? getScheduledCallService(services.storage).getNextUpcoming(profile.id)
              : Promise.resolve(null),
          ]);

          const weatherResult = secondary[0].status === 'fulfilled' ? secondary[0].value : null;
          if (weatherResult && typeof weatherResult === 'object' && 'ok' in weatherResult) {
            setWeatherBundle(weatherResult.ok ? weatherResult.data : null);
          } else {
            setWeatherBundle(null);
          }

          const daysAway = secondary[1].status === 'fulfilled' ? secondary[1].value : 0;
          setRitualState(secondary[2].status === 'fulfilled' ? secondary[2].value : null);
          const schedule = secondary[3].status === 'fulfilled' ? secondary[3].value : null;
          const studioPrefs =
            (secondary[4].status === 'fulfilled' ? secondary[4].value : null) ??
            createDefaultStudioExtendedPrefs();
          const existingFocus = secondary[5].status === 'fulfilled' ? secondary[5].value : null;
          setReflectionPending(secondary[6].status === 'fulfilled' ? Boolean(secondary[6].value) : false);
          setUpcomingCall(
            secondary[7].status === 'fulfilled'
              ? (secondary[7].value as ScheduledCompanionCall | null)
              : null,
          );

          if (isFeatureVisible('faithValues')) {
            void getFaithValuesService(services.storage)
              .getHomeSummary(profile.id)
              .then((summary) => {
                if (summary?.enabled) {
                  setFaithHome({ mode: summary.mode, hasIntention: summary.hasIntention });
                } else {
                  setFaithHome(null);
                }
              })
              .catch(() => setFaithHome(null));
          }

          const activeGoal = dash?.dailyBriefing?.activeGoals?.[0] ?? null;
          const nextRoutine = schedule?.nextBlock?.title ?? null;
          const followUpTopic = dash?.phase11?.followUp?.topic ?? null;

          await syncCompanionFocusFromSignals({
            userId: profile.id,
            activeGoalTitle: activeGoal?.title,
            followUpTopic,
            nextRoutineTitle: nextRoutine,
            todayFocusLine: dash?.phase11?.todayFocus || dash?.phase11?.rhythm?.focusLine || null,
          }).catch(() => undefined);

          const focusState = (await getCompanionFocusState(profile.id).catch(() => null)) ?? existingFocus;
          const checkInService = getDailyCheckInService(services.storage);
          const [morningCheckIn, eveningCheckIn, lastGreetingKey] = await Promise.all([
            checkInService.getTodayEntry('morning').catch(() => null),
            checkInService.getTodayEntry('evening').catch(() => null),
            getLastGreetingKey().catch(() => null),
          ]);
          const moodLabel =
            eveningCheckIn?.answers.mood ??
            eveningCheckIn?.mood ??
            morningCheckIn?.answers.mood ??
            morningCheckIn?.mood ??
            null;

          const greeting = buildCompanionGreeting({
            profile,
            memories: dash?.memories ?? [],
            streakDays: dash?.routineSummary?.streakDays,
            daysAway,
            voxaName: getVoxaDisplayName(profile),
            activeGoal,
            nextRoutineTitle: nextRoutine,
            followUpTopic,
            conversationSummary: null,
            greetingStyle: studioPrefs.greetingStyle,
            focusState,
            moodLabel,
            lastGreetingKey,
          });
          setPresence(greeting);
          if (greeting.mood === 'celebrating') void hapticCelebrate();
          await Promise.all([
            recordCompanionVisit().catch(() => undefined),
            rememberLastGreeting(greeting).catch(() => undefined),
          ]);

          const pending = dash?.phase10?.pendingLevelUp;
          if (pending) {
            const reward = dash?.phase10?.rewards?.at(-1)?.title;
            void getCelebrationService(services.storage)
              .showIfNew(profile.id, {
                kind: 'level_up',
                eventKey: `level_up:${pending.newLevel}`,
                title: 'Level up!',
                subtitle: pending.message || buildLevelUpMessage(pending.newLevel),
                emoji: '⭐',
                oldLevel: pending.oldLevel,
                newLevel: pending.newLevel,
                rewardTitle: reward,
              })
              .then((shown) => {
                if (shown) void getCelebrationService(services.storage).markLevelUpShown(profile.id);
              });
          }
        } catch (err) {
          // Secondary warm-up must never blank Home once dashboard loaded.
          console.warn('[Home] Secondary warm-up failed (non-blocking):', err);
        } finally {
          recordTiming('home.warm', Date.now() - started);
        }
      })();
    }, [load, profile, services.storage, services.repositories]),
  );

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const refreshPhase10 = useCallback(() => {
    invalidate();
    invalidateDashboardCache();
    void load(true);
  }, [invalidate, load]);

  if (isLoading && !dashboard) {
    return <BootLoadingScreen />;
  }

  if (loadError && !dashboard) {
    return (
      <ScreenShell padded={false} safeBottom={false}>
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load Home"
          message={loadError ?? FRIENDLY_ERRORS.home}
          actionLabel="Retry"
          onAction={() => {
            setLoadError(null);
            void load(true).catch((err) => {
              console.error('[Home] Retry failed:', err);
              setLoadError(friendlyErrorMessage(err, FRIENDLY_ERRORS.home));
            });
          }}
        />
      </ScreenShell>
    );
  }

  if (!dashboard || !profile) return null;

  const voxaName = getVoxaDisplayName(profile);
  const voxaTint = getVoxaAvatarTint(profile);
  const phase7 = dashboard.phase7;
  const phase8 = dashboard.phase8;
  const phase10 = dashboard.phase10;
  const phase11 = dashboard.phase11;
  const phase12 = dashboard.phase12;

  const openTalk = (starter?: string) => {
    if (phase11.wowMoment) {
      void getLivingWowService(services.storage).markShown(profile.id, phase11.wowMoment.id);
    }
    navigation.navigate('Talk', starter ? { starterPrompt: starter } : undefined);
  };

  const respondFollowUp = () => {
    if (phase11.followUp) {
      void getFollowUpEngineService(services.storage).resolve(phase11.followUp.id, profile.id);
      openTalk(phase11.followUp.prompt);
      return;
    }
    openTalk(dashboard.dailyBriefing.suggestedAction);
  };

  return (
    <ScreenShell padded={false} safeBottom={false}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.primarySoft} />}>
        <FadeIn>
          <HomeHeroSection
            greeting={presence?.greeting ?? phase11.rhythm.greeting}
            headline={presence?.headline ?? phase11.emotionalMessage}
            subline={
              presence?.subline ??
              formatHomeHeroSublineFromRaw(phase11.rhythm.focusLine || phase11.todayFocus || '')
            }
            tint={voxaTint}
            orbMood={
              presence?.mood === 'celebrating'
                ? 'celebrating'
                : presence?.mood === 'sleepy'
                  ? 'sleepy'
                  : presence?.mood === 'energetic'
                    ? 'excited'
                    : presence?.mood === 'warm'
                      ? 'happy'
                      : phase11.mood
            }
            orbState={phase7.livingCompanion.state}
            orbIntensity={phase7.livingCompanion.intensity}
            primaryLabel={`Talk to ${voxaName}`}
            onPrimary={() => openTalk(phase11.talkStarter ?? undefined)}
            onOrbPress={() => openTalk(phase11.talkStarter ?? undefined)}
            onSettings={() => navigation.navigate('You')}
            onCheckIn={
              ritualState?.pendingPeriod
                ? () => navigation.navigate('DailyCheckIn', { period: ritualState.pendingPeriod! })
                : undefined
            }
            onRoutine={() => navigateToRoutine(navigation)}
          />
        </FadeIn>

        {dashboard.phase4.delightMoment && !dismissedDelight ? (
          <DelightBanner
            moment={dashboard.phase4.delightMoment}
            onDismiss={() => {
              setDismissedDelight(true);
              void getDelightMomentsService(services.storage).markShown(dashboard.phase4.delightMoment!);
            }}
          />
        ) : phase8.milestone && !dismissedMilestone ? (
          <DelightBanner
            moment={{
              id: phase8.milestone.id,
              kind: 'milestone',
              title: phase8.milestone.title,
              message: phase8.milestone.message,
              showConfetti: phase8.milestone.showConfetti,
              priority: 90,
            }}
            onDismiss={() => {
              setDismissedMilestone(true);
              void getConversationMilestonesService(services.storage).markShown(phase8.milestone!);
              if (phase8.milestone?.showConfetti) void hapticCelebrate();
            }}
          />
        ) : null}

        <StaggerFade index={0}>
          <HomeMorningBriefCard
            dailyBriefing={dashboard.dailyBriefing}
            phase11={phase11}
            phase12={phase12}
            upcomingReminder={dashboard.upcomingReminders[0] ?? null}
            routineSummary={dashboard.routineSummary}
            reflectionPending={reflectionPending}
            weatherBundle={weatherBundle}
            showRelationship={false}
            onFollowUp={respondFollowUp}
            onReflection={() => navigation.navigate('DailyReflection')}
            onNews={() => navigation.navigate('DailyNews')}
            onRelationship={() => navigation.navigate('MyCompanion')}
            onRoutine={() => navigateToRoutine(navigation)}
            onReminder={() => navigation.navigate('CreateReminder')}
          />
        </StaggerFade>

        <StaggerFade index={1}>
          <TodayQuickActions
            onAction={(starter, id) => {
              void hapticLight();
              if (id === 'journal') {
                navigation.navigate('MoodJournal');
                return;
              }
              openTalk(id === 'challenge' ? CHALLENGE_ME_STARTER : starter);
            }}
          />
        </StaggerFade>

        {isScheduledCallsEnabled() ? (
          <StaggerFade index={0}>
            <UpcomingScheduledCallCard
              call={upcomingCall}
              companionName={voxaName}
              onPressSchedule={() => navigation.navigate('ScheduledCalls')}
              onPressEdit={
                upcomingCall
                  ? () => navigation.navigate('ScheduleCompanionCall', { callId: upcomingCall.id })
                  : undefined
              }
              onPressCallNow={
                upcomingCall && isRealtimeVoiceEnabled()
                  ? () =>
                      navigation.navigate('RealtimeCall', {
                        autoStart: true,
                        scheduledCallId: upcomingCall.id,
                        fromScheduledCall: true,
                      })
                  : undefined
              }
              onPressCancel={
                upcomingCall
                  ? () => {
                      void getScheduledCallService(services.storage)
                        .cancel(profile.id, upcomingCall.id)
                        .then(() => setUpcomingCall(null));
                    }
                  : undefined
              }
            />
          </StaggerFade>
        ) : null}

        {isFeatureVisible('calorieTracking') ? (
          <StaggerFade index={2}>
            <NutritionHomeSummary onPress={() => navigation.navigate('NutritionDashboard')} />
          </StaggerFade>
        ) : null}

        {faithHome && isFeatureVisible('faithValues') ? (
          <FaithValuesHomeCard
            mode={faithHome.mode}
            hasIntention={faithHome.hasIntention}
            onPress={() => navigation.navigate('FaithValuesHub')}
          />
        ) : null}

        {isFeatureVisible('notes') ? (
          <StaggerFade index={3}>
            <Pressable
              style={styles.notesShortcut}
              onPress={() => {
                void hapticLight();
                navigation.navigate('NotesHub');
              }}
              accessibilityRole="button"
              accessibilityLabel="Open Notes">
              <View style={styles.notesIconWrap}>
                <Ionicons name="document-text-outline" size={18} color={colors.primarySoft} />
              </View>
              <View style={styles.notesCopy}>
                <VoxaText variant="caption" color="textMuted">
                  Notes
                </VoxaText>
                <VoxaText variant="caption" color="textSecondary">
                  Capture ideas and plans
                </VoxaText>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </StaggerFade>
        ) : null}

        {isFeatureVisible('socialGames') ? (
        <View style={styles.adventureWrap}>
        <TodaysAdventureCard
          data={phase10}
          onPrimary={() => {
            const a = phase10.adventure;
            if (a.primaryAction === 'spin') {
              navigation.navigate('DailySpin');
              return;
            }
            if (a.primaryAction === 'challenge') {
              navigation.navigate('DailyChallenge');
              return;
            }
            if (a.primaryAction === 'mission') {
              navigation.navigate('WeeklyMission');
              return;
            }
            if (isFeatureVisible('socialGames') || a.featuredGame) {
              navigation.navigate('GamesHub');
              return;
            }
            navigation.navigate('DailyChallenge');
          }}
          onChallengeDetails={() => navigation.navigate('DailyChallenge')}
          onMission={() => navigation.navigate('WeeklyMission')}
          onSecondary={() => {
            if (isFeatureVisible('socialGames')) {
              navigation.navigate('GamesHub');
              return;
            }
            const s = phase10.adventure.surprise;
            if (s) {
              void getDailySurpriseService(services.storage).markShown(profile.id).then(refreshPhase10);
              navigation.navigate('Talk', { starterPrompt: s.actionPrompt ?? s.line });
              return;
            }
            const card = phase10.adventure.deckCard;
            if (card) navigation.navigate('Talk', { starterPrompt: card.prompt });
            else navigation.navigate('ConversationDecks');
          }}
          secondaryLabel={
            isFeatureVisible('socialGames')
              ? 'Open Games'
              : phase10.adventure.surprise
                ? 'Open surprise'
                : phase10.adventure.deckCard
                  ? 'Conversation card'
                  : undefined
          }
        />
        </View>
        ) : null}
      </ScrollView>
      <CommandBarSheet
        visible={commandOpen}
        onClose={() => setCommandOpen(false)}
        onNavigate={(result) => handleCommandBarResult(navigation, result)}
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.md,
    paddingBottom: layout.tabBarHeight + spacing.xxxl,
    gap: spacing.lg,
  },
  skeletonWrap: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xl,
    gap: spacing.md,
  },
  skeletonCard: { marginTop: 0 },
  notesShortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md12,
    paddingVertical: spacing.md12,
    paddingHorizontal: spacing.md12,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceQuiet,
    minHeight: 56,
  },
  notesIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(45, 212, 191, 0.08)',
  },
  notesCopy: { flex: 1, gap: 1 },
  adventureWrap: {
    marginTop: spacing.md,
    opacity: 0.92,
  },
});
