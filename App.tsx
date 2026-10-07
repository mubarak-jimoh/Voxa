import { NavigationContainer, DarkTheme, useNavigationContainerRef } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorState } from './src/components/ui/screen-state';
import { BootLoadingScreen } from './src/components/ui/boot-loading-screen';
import { AppErrorBoundary } from './src/components/ui/app-error-boundary';
import { colors } from './src/constants/theme';
import { hasSupabaseConfig } from './src/config/env';
import { isScheduledCallsEnabled } from './src/config/scheduled-calls';
import { AuthProvider, useAuth } from './src/context/auth-context';
import { VoxaProvider, useVoxa } from './src/context/voxa-context';
import { AuthNavigator } from './src/navigation/auth-navigator';
import { RootNavigator } from './src/navigation/root-navigator';
import { OnboardingScreen } from './src/screens/onboarding-screen';
import { CelebrationOverlay } from './src/components/phase10/celebration-overlay';
import { useProactiveCheckInNotifications } from './src/hooks/use-proactive-check-in-notifications';
import { useScheduledCallNotifications } from './src/hooks/use-scheduled-call-notifications';
import { useLocalNotificationRouting } from './src/hooks/use-local-notification-routing';
import { runScheduledCallNotificationCleanup } from './src/services/scheduled-calls/scheduled-call-notification-cleanup';
import { RootStackParamList } from './src/navigation/types';

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.tabBar,
    border: colors.glassBorder,
    primary: colors.primary,
    text: colors.text,
  },
};

function AppRoot() {
  const { isLoading, error, isReady, reinitialize, profile, services } = useVoxa();
  const [onboardingDone, setOnboardingDone] = useState(false);
  const navigationRef = useNavigationContainerRef<RootStackParamList>();

  useLocalNotificationRouting({
    navigationRef,
    enabled: isReady && Boolean(profile?.onboardingComplete),
  });

  useProactiveCheckInNotifications({
    profile,
    services,
    navigationRef,
    enabled: isReady && Boolean(profile?.onboardingComplete),
  });

  useScheduledCallNotifications({
    profile,
    services,
    navigationRef,
    enabled:
      isScheduledCallsEnabled() && isReady && Boolean(profile?.onboardingComplete),
  });

  useEffect(() => {
    if (!isReady || isScheduledCallsEnabled()) return;
    void runScheduledCallNotificationCleanup(services.storage, profile?.id).catch(() => undefined);
  }, [isReady, profile?.id, services.storage]);

  if (isLoading) {
    return (
      <View style={styles.boot}>
        <BootLoadingScreen />
      </View>
    );
  }

  if (error || !isReady) {
    return (
      <View style={styles.boot}>
        <ErrorState message={error ?? 'Unable to start Voxa.'} onRetry={reinitialize} />
      </View>
    );
  }

  if (profile && !profile.onboardingComplete && !onboardingDone) {
    return (
      <View style={styles.boot}>
        <StatusBar style="light" />
        <OnboardingScreen onComplete={() => setOnboardingDone(true)} />
      </View>
    );
  }

  const initialRoute = hasSupabaseConfig() ? 'MainTabs' : 'Welcome';

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      <StatusBar style="light" />
      <RootNavigator initialRouteName={initialRoute} />
      <CelebrationOverlay />
    </NavigationContainer>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();
  const sessionKey = auth.session?.user.id ?? 'local';

  return (
    <VoxaProvider key={sessionKey}>
      <AppRoot />
    </VoxaProvider>
  );
}

function AppGate() {
  const auth = useAuth();

  if (auth.isAuthEnabled && auth.isLoading) {
    return (
      <View style={styles.boot}>
        <BootLoadingScreen />
      </View>
    );
  }

  if (auth.isAuthEnabled && !auth.session) {
    return (
      <NavigationContainer theme={navTheme}>
        <StatusBar style="light" />
        <AuthNavigator />
      </NavigationContainer>
    );
  }

  return <AuthenticatedApp />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <AuthProvider>
          <AppGate />
        </AuthProvider>
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
