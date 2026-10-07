import { Pressable, StyleSheet, View } from 'react-native';

import { VoxaText } from '../ui/voxa-text';
import { colors, radius, spacing } from '../../constants/theme';

export type ContextChip = {
  id: string;
  label: string;
  kind: 'memory' | 'goal' | 'routine' | 'context';
};

type Props = {
  chips: ContextChip[];
  onSelect?: (chip: ContextChip) => void;
};

export function ChatContextChips({ chips, onSelect }: Props) {
  const visible = chips.filter((chip) => chip.label.trim().length > 0);
  if (visible.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {visible.map((chip) => (
        <Pressable
          key={chip.id}
          style={[styles.chip, chip.kind === 'memory' && styles.memory, chip.kind === 'goal' && styles.goal]}
          onPress={() => onSelect?.(chip)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={chip.label}>
          <VoxaText variant="caption" color="textSecondary" numberOfLines={1} style={styles.label}>
            {chip.label}
          </VoxaText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  chip: {
    alignSelf: 'flex-start',
    flexGrow: 0,
    flexShrink: 1,
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.chip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surfaceQuiet,
    justifyContent: 'center',
  },
  label: { flexShrink: 1, maxWidth: 180 },
  memory: { borderColor: `${colors.primarySoft}44` },
  goal: { borderColor: `${colors.primarySoft}66` },
});
