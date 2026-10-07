import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';

import { colors, shadows } from '../../constants/theme';

type Props = {
  visible: boolean;
  onPress: () => void;
};

export function TalkJumpToLatestButton({ visible, onPress }: Props) {
  if (!visible) return null;
  return (
    <Pressable
      onPress={onPress}
      style={styles.button}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Scroll to latest message">
      <Ionicons name="chevron-down" size={18} color={colors.primarySoft} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceStrong,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    zIndex: 4,
    ...shadows.soft,
  },
});
