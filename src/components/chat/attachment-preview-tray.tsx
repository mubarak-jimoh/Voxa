import { Ionicons } from '@expo/vector-icons';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../../constants/theme';
import { pendingAttachmentPreviewLabel } from '../../services/chat/pending-attachment-preview';
import { PendingAttachmentInput } from '../../types';
import { VoxaText } from '../ui/voxa-text';
import { VoiceNoteWaveform } from './voice-note-waveform';

type AttachmentPreviewTrayProps = {
  attachments: PendingAttachmentInput[];
  onRemove: (index: number) => void;
};

function formatDuration(seconds?: number) {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function AttachmentPreviewTray({ attachments, onRemove }: AttachmentPreviewTrayProps) {
  if (attachments.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tray}
      style={styles.container}>
      {attachments.map((item, index) => (
        <View
          key={`${item.localUri}-${index}`}
          style={[styles.chip, item.type === 'audio' && styles.audioChip]}
          accessibilityLabel={pendingAttachmentPreviewLabel(item)}>
          {item.type === 'image' || item.thumbnailUri ? (
            <Image source={{ uri: item.thumbnailUri ?? item.localUri }} style={styles.thumb} />
          ) : item.type === 'audio' ? (
            <View style={styles.audioPreview}>
              <Ionicons name="mic" size={16} color={colors.primarySoft} />
              <VoiceNoteWaveform active barCount={8} level={0.5} />
              <VoxaText variant="caption" color="textMuted">
                {formatDuration(item.durationSeconds)}
              </VoxaText>
            </View>
          ) : (
            <View style={styles.iconWrap}>
              <Ionicons
                name={item.type === 'video' ? 'videocam' : 'document'}
                size={18}
                color={colors.primarySoft}
              />
            </View>
          )}
          <VoxaText variant="caption" color="textSecondary" numberOfLines={1} style={styles.label}>
            {pendingAttachmentPreviewLabel(item)}
          </VoxaText>
          <Pressable
            onPress={() => onRemove(index)}
            style={styles.removeBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${pendingAttachmentPreviewLabel(item).toLowerCase()}`}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { maxHeight: 88 },
  tray: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    width: 96,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceStrong,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    gap: spacing.xs,
  },
  audioChip: { width: 150 },
  audioPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    height: 48,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  thumb: {
    width: '100%',
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  iconWrap: {
    width: '100%',
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 11 },
  removeBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
  },
});
