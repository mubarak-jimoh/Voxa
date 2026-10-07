import { Ionicons } from '@expo/vector-icons';
import { memo, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isFeatureVisible } from '../../config/feature-status';
import { colors, radius, spacing } from '../../constants/theme';
import {
  messageActionsForRole,
  sharePayloadForMessage,
  shouldCloseMessageActionMenu,
} from '../../services/chat/message-actions';
import { ChatMessageView } from '../../types';
import { shareMessageText } from '../../utils/copy-text';
import { hapticLight } from '../../utils/haptics';
import { VoxaText } from '../ui/voxa-text';
import { ChatMarkdownText } from '../phase11/chat-markdown-text';
import { LiveCompanionOrb } from '../live-companion/live-companion-orb';
import { VoiceNoteAttachment } from './voice-note-attachment';

type ChatMessageBubbleProps = {
  message: ChatMessageView;
  voxaTint: string;
  voxaName?: string;
  showAvatar?: boolean;
  bookmarked?: boolean;
  isSpeaking?: boolean;
  onRetryUpload?: (attachmentId: string) => void;
  onRemember?: (message: ChatMessageView) => void;
  onBookmark?: (message: ChatMessageView) => void;
  onDelete?: (message: ChatMessageView) => void;
  onRetrySend?: (message: ChatMessageView) => void;
  onEdit?: (message: ChatMessageView) => void;
  onPlayAloud?: (message: ChatMessageView) => void;
  onSavePhotoMemory?: (message: ChatMessageView) => void;
  onSaveVoiceMemory?: (message: ChatMessageView) => void;
  onCopyTranscript?: (message: ChatMessageView) => void;
};

function ChatMessageBubbleComponent({
  message,
  voxaTint,
  voxaName = 'Voxa',
  showAvatar = true,
  bookmarked,
  isSpeaking,
  onRetryUpload,
  onRemember,
  onBookmark,
  onDelete,
  onRetrySend,
  onEdit,
  onPlayAloud,
  onSavePhotoMemory,
  onSaveVoiceMemory,
}: ChatMessageBubbleProps) {
  const isUser = message.role === 'user';
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(4)).current;
  const [actionsOpen, setActionsOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [fade, slide]);

  const audioAttachment = message.attachments?.find((item) => item.type === 'audio');
  const hasPhoto = message.attachments?.some((item) => item.type === 'image');
  const hasVoice = Boolean(audioAttachment);
  const transcript = audioAttachment?.transcription ?? message.text;
  const exactText = transcript?.trim() ?? '';
  const primaryActions = messageActionsForRole(isUser ? 'user' : 'voxa', {
    canSpeak: Boolean(onPlayAloud && isFeatureVisible('playAloud') && exactText),
  });

  const closeMenu = (event: 'outside_press' | 'action_selected') => {
    if (shouldCloseMessageActionMenu(event)) {
      setActionsOpen(false);
    }
  };

  const shareText = async () => {
    if (!exactText) return;
    await shareMessageText(sharePayloadForMessage(exactText).message);
    closeMenu('action_selected');
  };

  const openActions = () => {
    if (selectMode) return;
    void hapticLight();
    setActionsOpen(true);
  };

  return (
    <>
      <Animated.View
        style={[
          styles.row,
          isUser && styles.rowUser,
          !isUser && !showAvatar && styles.rowAvatarGutter,
          { opacity: fade, transform: [{ translateY: slide }] },
        ]}>
        {!isUser ? (
          showAvatar ? (
            <View style={styles.bubbleAvatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <LiveCompanionOrb size={22} tint={voxaTint} active mood="calm" state="idle" intensity={0.35} />
            </View>
          ) : (
            <View style={styles.avatarSpacer} />
          )
        ) : null}
        <Pressable
          onPress={() => {
            if (selectMode) {
              setSelectMode(false);
              return;
            }
            if (message.status === 'failed' && isUser && onRetrySend) {
              onRetrySend(message);
            }
          }}
          onLongPress={openActions}
          delayLongPress={320}
          accessibilityRole="text"
          accessibilityHint="Long press for message actions"
          accessibilityLabel={isUser ? 'Your message' : `${voxaName} message`}
          style={({ pressed }) => [
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleVoxa,
            message.status === 'failed' && styles.failed,
            bookmarked && styles.bookmarked,
            hasVoice && styles.voiceBubble,
            selectMode && styles.selectMode,
            pressed && !selectMode && styles.bubblePressed,
          ]}>
          {message.attachments?.map((attachment) => {
            if (attachment.type === 'image' && (attachment.remoteUrl ?? attachment.localUri)) {
              return (
                <Image
                  key={attachment.id}
                  source={{ uri: attachment.remoteUrl ?? attachment.localUri }}
                  style={styles.image}
                  resizeMode="cover"
                />
              );
            }
            if (attachment.type === 'audio') {
              return (
                <VoiceNoteAttachment
                  key={attachment.id}
                  attachment={attachment}
                  onRetryUpload={
                    attachment.uploadStatus === 'failed' && onRetryUpload
                      ? () => onRetryUpload(attachment.id)
                      : undefined
                  }
                />
              );
            }
            return null;
          })}
          {message.text && !hasVoice ? (
            isUser ? (
              <VoxaText variant="body" selectable={selectMode} style={styles.messageText}>
                {message.text}
              </VoxaText>
            ) : (
              <ChatMarkdownText text={message.text} selectable={selectMode} />
            )
          ) : null}
          {!isUser && message.sourceLine ? (
            <VoxaText variant="caption" color="textMuted" style={styles.sourceLine}>
              {message.sourceLine}
            </VoxaText>
          ) : null}
          <View style={styles.footer}>
            {bookmarked ? <Ionicons name="bookmark" size={11} color={colors.primarySoft} /> : null}
            <VoxaText variant="caption" color="textMuted" style={styles.time}>
              {message.time}
              {message.status === 'failed'
                ? ' · Failed — tap to retry'
                : message.status === 'pending'
                  ? ' · Sending…'
                  : selectMode
                    ? ' · Select text'
                    : ''}
            </VoxaText>
            {!isUser && isFeatureVisible('playAloud') && message.text ? (
              <Pressable
                onPress={() => onPlayAloud?.(message)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={isSpeaking ? 'Stop speaking' : `Play ${voxaName} aloud`}
                style={styles.speakBtn}>
                <Ionicons
                  name={isSpeaking ? 'stop-circle' : 'volume-medium'}
                  size={16}
                  color={isSpeaking ? colors.primary : colors.textMuted}
                />
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </Animated.View>

      <Modal
        visible={actionsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => closeMenu('outside_press')}
        accessibilityViewIsModal>
        <Pressable
          style={styles.backdrop}
          onPress={() => closeMenu('outside_press')}
          accessibilityRole="button"
          accessibilityLabel="Dismiss message actions">
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
            onPress={(event) => event.stopPropagation()}
            accessibilityRole="menu"
            accessibilityLabel="Message actions">
            {isUser && primaryActions.includes('edit') && onEdit && exactText ? (
              <ActionRow
                icon="create-outline"
                label="Edit"
                onPress={() => {
                  onEdit(message);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {primaryActions.includes('select_text') && exactText ? (
              <ActionRow
                icon="document-text-outline"
                label="Select text"
                onPress={() => {
                  setSelectMode(true);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {!isUser && primaryActions.includes('speak') && onPlayAloud ? (
              <ActionRow
                icon={isSpeaking ? 'stop-circle-outline' : 'volume-high-outline'}
                label={isSpeaking ? 'Stop speaking' : 'Speak'}
                onPress={() => {
                  onPlayAloud(message);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {primaryActions.includes('share') && exactText ? (
              <ActionRow icon="share-outline" label="Share" onPress={() => void shareText()} />
            ) : null}
            {onRemember ? (
              <ActionRow
                icon="sparkles-outline"
                label="Remember this"
                onPress={() => {
                  onRemember(message);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {hasVoice && onSaveVoiceMemory ? (
              <ActionRow
                icon="bookmark-outline"
                label="Save to Journey"
                onPress={() => {
                  onSaveVoiceMemory(message);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {hasPhoto && onSavePhotoMemory ? (
              <ActionRow
                icon="images-outline"
                label="Save to Journey"
                onPress={() => {
                  onSavePhotoMemory(message);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {hasVoice && audioAttachment?.uploadStatus === 'failed' && onRetryUpload ? (
              <ActionRow
                icon="cloud-upload-outline"
                label="Retry upload"
                onPress={() => {
                  onRetryUpload(audioAttachment.id);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {onBookmark ? (
              <ActionRow
                icon={bookmarked ? 'bookmark' : 'bookmark-outline'}
                label={bookmarked ? 'Remove bookmark' : 'Bookmark'}
                onPress={() => {
                  onBookmark(message);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
            {isUser && onDelete ? (
              <ActionRow
                icon="trash-outline"
                label="Delete"
                onPress={() => {
                  onDelete(message);
                  closeMenu('action_selected');
                }}
              />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}>
      <Ionicons name={icon} size={18} color={colors.primarySoft} />
      <VoxaText variant="body">{label}</VoxaText>
    </Pressable>
  );
}

export const ChatMessageBubble = memo(ChatMessageBubbleComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    gap: spacing.sm,
    marginBottom: spacing.md12,
  },
  rowUser: { justifyContent: 'flex-end' },
  rowAvatarGutter: {},
  bubbleAvatar: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
    marginBottom: 2,
    overflow: 'hidden',
  },
  avatarSpacer: {
    width: 24,
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    gap: spacing.xs,
  },
  bubblePressed: { opacity: 0.92 },
  voiceBubble: { minWidth: 250 },
  bubbleVoxa: {
    backgroundColor: 'transparent',
    paddingHorizontal: spacing.xs,
    paddingLeft: 0,
    maxWidth: '88%',
  },
  bubbleUser: {
    backgroundColor: colors.chatUser,
    borderBottomRightRadius: 6,
  },
  selectMode: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: `${colors.primarySoft}66`,
  },
  bookmarked: { borderWidth: StyleSheet.hairlineWidth, borderColor: `${colors.primarySoft}55` },
  failed: { borderWidth: 1, borderColor: colors.danger },
  messageText: { lineHeight: 23, fontSize: 16 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing.xs,
    marginTop: 2,
  },
  speakBtn: {
    minWidth: 28,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  time: { fontSize: 11, opacity: 0.85 },
  sourceLine: { fontSize: 11, marginTop: 6, opacity: 0.8 },
  image: { width: 220, height: 160, borderRadius: radius.md, backgroundColor: colors.surface },
  backdrop: { flex: 1, backgroundColor: 'rgba(6,6,14,0.72)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#12121E',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.sm,
  },
  actionPressed: { opacity: 0.7 },
});
