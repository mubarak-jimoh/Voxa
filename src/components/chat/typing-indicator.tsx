import { StyleSheet, View } from 'react-native';

import { spacing } from '../../constants/theme';
import { ChatMarkdownText } from '../phase11/chat-markdown-text';
import { VoxaText } from '../ui/voxa-text';
import { TypingDots } from '../premium/premium-ui';

type Props = {
  voxaName: string;
  tint: string;
  streamingText?: string | null;
  thinkingLabel?: string;
};

export function TypingIndicator({ voxaName, tint, streamingText, thinkingLabel }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.avatarSpacer} />
      <View style={styles.bubble}>
        {streamingText ? (
          <ChatMarkdownText text={streamingText} tint={tint} />
        ) : (
          <View style={styles.thinkingRow}>
            <TypingDots tint={tint} />
            <VoxaText variant="caption" color="textMuted">
              {thinkingLabel ?? `${voxaName} is thinking`}
            </VoxaText>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  avatarSpacer: { width: 24 },
  bubble: {
    maxWidth: '88%',
    paddingVertical: spacing.xs,
    paddingRight: spacing.sm,
  },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
