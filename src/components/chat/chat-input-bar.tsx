import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isFeatureVisible } from '../../config/feature-status';
import { isMicrophoneChatEnabled, isVoiceNotesEnabled } from '../../config/release-voice';
import { colors, layout, radius, spacing } from '../../constants/theme';
import { useVoxa } from '../../context/voxa-context';
import { prepareChatImage } from '../../services/attachments/prepare-chat-image';
import { TalkAIError } from '../../services/ai/talk-ai-errors';
import { PendingAttachmentInput } from '../../types';
import {
  permissionErrorLabel,
  requestCameraPermission,
  requestMediaLibraryPermission,
} from '../../services/attachments/attachment-permissions';
import { getUpgradeCopy } from '../../services/billing/feature-registry';
import { checkVoiceNoteGate } from '../../services/voice-notes/voice-note-access';
import { voiceNotePlaybackService } from '../../services/voice-notes/voice-note-playback-service';
import { voiceNoteLog } from '../../services/voice-notes/voice-note-logger';
import { voiceNoteRecordingService } from '../../services/voice-notes/voice-note-recording-service';
import {
  TALK_EDIT_BANNER,
  talkComposerEditPlaceholder,
  talkComposerPlaceholder,
} from '../../constants/talk-copy';
import { VoxaText } from '../ui/voxa-text';
import { AttachmentPreviewTray } from './attachment-preview-tray';
import { VoiceNoteRecorder } from './voice-note-recorder';
import { shouldRestorePendingAttachments } from '../../services/chat/pending-attachment-send';

type ChatInputBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: (attachments: PendingAttachmentInput[]) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
  voxaName: string;
  onVoiceNoteLimit?: (message: string) => void;
  editing?: boolean;
  onCancelEdit?: () => void;
};

export function ChatInputBar({
  value,
  onChangeText,
  onSend,
  disabled,
  voxaName,
  onVoiceNoteLimit,
  editing,
  onCancelEdit,
}: ChatInputBarProps) {
  const insets = useSafeAreaInsets();
  const { profile, services } = useVoxa();
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentInput[]>([]);
  const [recordingMode, setRecordingMode] = useState(false);
  const [voiceNoteBusy, setVoiceNoteBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const submitLockRef = useRef(false);

  const showCamera = isFeatureVisible('cameraPhoto');
  const showVoiceNote = isVoiceNotesEnabled() && isMicrophoneChatEnabled() && isFeatureVisible('voiceNote');
  const showGallery = isFeatureVisible('galleryPicker');

  useEffect(() => {
    if (showVoiceNote) {
      voiceNoteLog('BUTTON_RENDERED');
    }
  }, [showVoiceNote]);

  useEffect(() => {
    if (!editing) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(timer);
  }, [editing]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const addAttachment = (attachment: PendingAttachmentInput) => {
    setPendingAttachments((current) => [...current, attachment]);
  };

  const attachPreparedImage = async (asset: ImagePicker.ImagePickerAsset) => {
    try {
      const prepared = await prepareChatImage({
        localUri: asset.uri,
        mimeType: asset.mimeType ?? undefined,
        fileName: asset.fileName ?? undefined,
        width: asset.width,
        height: asset.height,
        sizeBytes: asset.fileSize,
      });
      addAttachment({
        type: 'image',
        localUri: prepared.localUri,
        mimeType: prepared.mimeType,
        fileName: prepared.fileName,
        sizeBytes: prepared.sizeBytes,
      });
    } catch (err) {
      const message =
        err instanceof TalkAIError
          ? err.userMessage
          : 'That photo could not be prepared. Try another image.';
      Alert.alert('Photo', message);
    }
  };

  const takePhoto = async () => {
    const granted = await requestCameraPermission();
    if (!granted) {
      Alert.alert('Permission needed', permissionErrorLabel('camera'));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]) {
      inputRef.current?.focus();
      return;
    }
    await attachPreparedImage(result.assets[0]);
    inputRef.current?.focus();
  };

  const pickFromGallery = async () => {
    const granted = await requestMediaLibraryPermission();
    if (!granted) {
      Alert.alert('Permission needed', permissionErrorLabel('mediaLibrary'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]) {
      inputRef.current?.focus();
      return;
    }
    await attachPreparedImage(result.assets[0]);
    inputRef.current?.focus();
  };

  /** "+" opens attach actions — not Tools. Cancel / deny leaves composer unchanged. */
  const openAttachmentSheet = () => {
    if (disabled) return;
    Keyboard.dismiss();

    if (Platform.OS === 'ios') {
      const options = showCamera
        ? ['Cancel', 'Choose Photo', 'Take Photo']
        : ['Cancel', 'Choose Photo'];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
          userInterfaceStyle: 'dark',
        },
        (buttonIndex) => {
          if (buttonIndex === 1) void pickFromGallery();
          else if (showCamera && buttonIndex === 2) void takePhoto();
        },
      );
      return;
    }

    const buttons: Array<{ text: string; style?: 'cancel'; onPress?: () => void }> = [
      { text: 'Choose Photo', onPress: () => void pickFromGallery() },
    ];
    if (showCamera) {
      buttons.push({ text: 'Take Photo', onPress: () => void takePhoto() });
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Attach a photo', undefined, buttons);
  };

  const closeVoicePanel = () => {
    voiceNoteLog('PANEL_CLOSE');
    setRecordingMode(false);
    void voiceNoteRecordingService.reset();
    void voiceNotePlaybackService.stop();
  };

  const startVoiceMode = async () => {
    if (disabled || voiceNoteBusy) return;
    voiceNoteLog('BUTTON_TAP');
    setVoiceNoteBusy(true);
    try {
      if (profile) {
        const gate = await checkVoiceNoteGate({
          userId: profile.id,
          subscription: services.subscription,
          featureGate: services.featureGate,
          usageTracking: services.usageTracking,
        });
        if (!gate.allowed) {
          const message = gate.reason ?? getUpgradeCopy('voice_note');
          onVoiceNoteLimit?.(message);
          return;
        }
      }
      await voiceNotePlaybackService.stop();
      voiceNoteLog('PANEL_OPEN');
      setRecordingMode(true);
    } finally {
      setVoiceNoteBusy(false);
    }
  };

  const canSend = (value.trim().length > 0 || pendingAttachments.length > 0) && !disabled && !recordingMode;

  const handleSend = () => {
    if (!canSend || submitLockRef.current) return;
    submitLockRef.current = true;
    const hasVoiceNote = pendingAttachments.some((item) => item.type === 'audio');
    if (hasVoiceNote) {
      voiceNoteLog('SEND_SUCCESS');
    }
    const snapshot = pendingAttachments;
    setPendingAttachments([]);
    setRecordingMode(false);
    void Promise.resolve(onSend(snapshot))
      .then((accepted) => {
        if (shouldRestorePendingAttachments(accepted)) {
          setPendingAttachments(snapshot);
        }
      })
      .finally(() => {
        submitLockRef.current = false;
      });
  };

  // When the keyboard is open it covers the home indicator, do not keep that inset
  // under the composer (it created a large dead zone above the keyboard).
  const bottomPad = keyboardVisible ? spacing.xs : Math.max(insets.bottom, spacing.sm);

  return (
    <View style={[styles.wrap, { paddingBottom: bottomPad }]}>
      {editing ? (
        <View style={styles.editBanner} accessibilityRole="text" accessibilityLabel="Editing message">
          <VoxaText variant="caption" color="primarySoft">
            {TALK_EDIT_BANNER}
          </VoxaText>
          <Pressable
            onPress={onCancelEdit}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel edit">
            <VoxaText variant="caption" color="textSecondary">
              Cancel
            </VoxaText>
          </Pressable>
        </View>
      ) : null}
      <AttachmentPreviewTray
        attachments={pendingAttachments}
        onRemove={(index) =>
          setPendingAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))
        }
      />

      <View style={styles.inputBar}>
        {recordingMode ? (
          <View style={styles.composerShell}>
            <VoiceNoteRecorder
              disabled={disabled}
              onCancel={closeVoicePanel}
              onRecorded={(result) => {
                voiceNoteLog('PREVIEW_READY');
                setRecordingMode(false);
                addAttachment({
                  type: 'audio',
                  localUri: result.uri,
                  mimeType: result.mimeType,
                  fileName: `voice-${Date.now()}.m4a`,
                  durationSeconds: Math.max(1, Math.round(result.durationMs / 1000)),
                  sizeBytes: result.sizeBytes,
                });
              }}
            />
          </View>
        ) : (
          <View style={[styles.composerShell, (focused || editing) && styles.composerFocused]}>
            <Pressable
              style={({ pressed }) => [styles.inlineIcon, pressed && styles.iconPressed]}
              onPress={openAttachmentSheet}
              disabled={disabled}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Attach a photo">
              <Ionicons name="add" size={22} color={colors.textSecondary} />
            </Pressable>

            {showCamera ? (
              <Pressable
                style={({ pressed }) => [styles.inlineIcon, pressed && styles.iconPressed]}
                onPress={() => void takePhoto()}
                disabled={disabled}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Take a photo">
                <Ionicons name="camera-outline" size={20} color={colors.textSecondary} />
              </Pressable>
            ) : null}

            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={onChangeText}
              placeholder={editing ? talkComposerEditPlaceholder() : talkComposerPlaceholder(voxaName)}
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              returnKeyType="send"
              onSubmitEditing={handleSend}
              editable={true}
              multiline
              maxFontSizeMultiplier={1.35}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />

            {showVoiceNote ? (
              <Pressable
                style={({ pressed }) => [styles.inlineIcon, pressed && styles.iconPressed]}
                onPress={() => void startVoiceMode()}
                disabled={disabled || voiceNoteBusy}
                hitSlop={6}
                accessibilityLabel="Record voice note">
                <Ionicons name="mic-outline" size={20} color={colors.textSecondary} />
              </Pressable>
            ) : null}

            <Pressable
              onPress={handleSend}
              disabled={!canSend}
              style={({ pressed }) => [
                styles.sendBtn,
                canSend ? styles.sendReady : styles.sendDisabled,
                pressed && canSend && styles.sendPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !canSend }}>
              <Ionicons
                name="arrow-up"
                size={18}
                color={canSend ? colors.background : colors.textMuted}
              />
            </Pressable>
          </View>
        )}
      </View>

      {showGallery && !recordingMode && !keyboardVisible ? (
        <View style={styles.secondaryRow}>
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.iconPressed]}
            onPress={() => void pickFromGallery()}
            disabled={disabled}
            accessibilityLabel="Choose from gallery">
            <Ionicons name="images-outline" size={18} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    paddingTop: spacing.xs,
  },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xs,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xs,
  },
  composerShell: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: spacing.xs,
    paddingRight: spacing.xs,
    paddingVertical: spacing.xs,
    minHeight: layout.composerMinHeight,
    borderRadius: radius.xl,
    backgroundColor: colors.surfaceQuiet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  composerFocused: {
    borderColor: `${colors.primarySoft}55`,
    backgroundColor: colors.surfaceStrong,
  },
  inlineIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  iconPressed: { opacity: 0.65 },
  secondaryRow: {
    flexDirection: 'row',
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.xs,
  },
  secondaryBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 17,
    lineHeight: 22,
    paddingVertical: 8,
    paddingHorizontal: spacing.xs,
    maxHeight: 120,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 3,
    marginLeft: 2,
  },
  sendReady: {
    backgroundColor: colors.primary,
  },
  sendDisabled: {
    backgroundColor: 'transparent',
  },
  sendPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
});
