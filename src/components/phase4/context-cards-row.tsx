import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../../constants/theme';
import { ContextCard } from '../../types/phase4-intelligence';
import { VoxaText } from '../ui/voxa-text';

type ContextCardsRowProps = {
  cards: ContextCard[];
  thinkingAbout?: string | null;
  onSelect: (card: ContextCard) => void;
};

export function ContextCardsRow({ cards, thinkingAbout, onSelect }: ContextCardsRowProps) {
  const visible = cards.filter((card) => card.label.trim().length > 0);
  if (visible.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <VoxaText variant="caption" color="textMuted" numberOfLines={1} style={styles.eyebrow}>
        {thinkingAbout ? `I'm thinking about ${thinkingAbout}` : "I'm thinking about..."}
      </VoxaText>
      <View style={styles.row}>
        {visible.map((card) => (
          <Pressable
            key={card.id}
            onPress={() => onSelect(card)}
            style={styles.chip}
            accessibilityRole="button"
            accessibilityLabel={card.label}>
            {card.emoji ? (
              <VoxaText variant="caption" style={styles.emoji}>
                {card.emoji}
              </VoxaText>
            ) : null}
            <VoxaText variant="caption" color="textSecondary" numberOfLines={1} style={styles.label}>
              {card.label}
            </VoxaText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexGrow: 0,
    flexShrink: 0,
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  eyebrow: { fontStyle: 'italic' },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: spacing.sm,
    flexGrow: 0,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexGrow: 0,
    flexShrink: 1,
    gap: 6,
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.chip,
    backgroundColor: `${colors.primarySoft}18`,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: `${colors.primarySoft}30`,
  },
  emoji: { flexGrow: 0, flexShrink: 0 },
  label: { flexShrink: 1, maxWidth: 168 },
});
