import { StyleSheet, View } from 'react-native';

import { colors, spacing } from '../../constants/theme';
import { VoxaText } from '../ui/voxa-text';
import { sanitizeTalkDisplayText } from '../../services/chat/sanitize-talk-display';
import { parseChatMarkdownBlocks, splitBoldSegments } from './chat-markdown';

type Props = {
  text: string;
  tint?: string;
  selectable?: boolean;
};

function InlineMarkdown({
  text,
  tint,
  selectable,
}: {
  text: string;
  tint: string;
  selectable?: boolean;
}) {
  const segments = splitBoldSegments(text);
  return (
    <VoxaText variant="body" selectable={selectable} style={{ color: tint }}>
      {segments.map((segment, index) =>
        segment.bold ? (
          <VoxaText
            key={index}
            variant="body"
            selectable={selectable}
            style={{ color: tint, fontWeight: '700' }}>
            {segment.text}
          </VoxaText>
        ) : (
          segment.text
        ),
      )}
    </VoxaText>
  );
}

/** Lightweight markdown-ish rendering for assistant replies. */
export function ChatMarkdownText({ text, tint = colors.text, selectable }: Props) {
  const blocks = parseChatMarkdownBlocks(sanitizeTalkDisplayText(text));

  return (
    <View style={styles.wrap}>
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return (
            <View key={i} style={styles.code}>
              <VoxaText variant="caption" selectable={selectable} style={{ color: colors.primarySoft, fontFamily: 'Menlo' }}>{block.text}</VoxaText>
            </View>
          );
        }

        if (block.type === 'bullets') {
          return (
            <View key={i} style={styles.list}>
              {block.items.map((item, j) => (
                <View key={j} style={styles.listItem}>
                  <VoxaText variant="body" selectable={selectable} style={{ color: tint }}>• </VoxaText>
                  <View style={styles.listCopy}>
                    <InlineMarkdown text={item} tint={tint} selectable={selectable} />
                  </View>
                </View>
              ))}
            </View>
          );
        }

        if (block.type === 'numbered') {
          return (
            <View key={i} style={styles.list}>
              {block.items.map((item, j) => (
                <InlineMarkdown key={j} text={item} tint={tint} selectable={selectable} />
              ))}
            </View>
          );
        }

        if (block.type === 'table') {
          return (
            <View key={i} style={styles.table}>
              {block.rows.map((row, j) => (
                <VoxaText key={j} variant="caption" selectable={selectable} style={{ color: tint }}>{row.replace(/\|/g, ' · ')}</VoxaText>
              ))}
            </View>
          );
        }

        return <InlineMarkdown key={i} text={block.text} tint={tint} selectable={selectable} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  code: {
    backgroundColor: colors.surfaceStrong,
    borderRadius: 8,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  list: { gap: spacing.xs, paddingLeft: spacing.xs },
  listItem: { flexDirection: 'row', alignItems: 'flex-start' },
  listCopy: { flex: 1, minWidth: 0 },
  table: { gap: 2, padding: spacing.sm, backgroundColor: colors.surfaceStrong, borderRadius: 8 },
});
