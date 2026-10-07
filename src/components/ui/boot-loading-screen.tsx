import { View, StyleSheet } from 'react-native';

import { LoadingPulse, SkeletonBlock } from '../premium/premium-ui';
import { ScreenShell } from './screen-shell';
import { layout, spacing } from '../../constants/theme';

export const BOOT_LOADING_LABEL = 'Waking up Voxa...';

/** Single boot layout for auth restore, companion sync, and Home first paint. */
export function BootLoadingScreen() {
  return (
    <ScreenShell padded={false} safeBottom={false}>
      <View style={styles.wrap}>
        <LoadingPulse label={BOOT_LOADING_LABEL} />
        <SkeletonBlock height={220} style={styles.card} />
        <SkeletonBlock height={96} style={styles.card} />
        <SkeletonBlock height={120} style={styles.card} />
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xl,
    gap: spacing.md,
  },
  card: { marginTop: 0 },
});
