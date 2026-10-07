import { Ionicons } from '@expo/vector-icons';
import { BottomTabNavigationProp, BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import {
  CompositeNavigationProp,
  CompositeScreenProps,
  useFocusEffect,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  Alert,
  Share,
  AppState,
  type AppStateStatus,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { SuggestedReplies } from '../components/chat/suggested-replies';
import { TypingIndicator } from '../components/chat/typing-indicator';
import { resolveTurnSuggestionPrompts } from '../services/chat/contextual-suggestions-service';
import { chatViewsToHistory } from '../services/chat/talk-critical-path';
import { LimitReachedModal } from '../components/subscription/limit-reached-modal';
import { ErrorState, LoadingState } from '../components/ui/screen-state';
import { ScreenShell } from '../components/ui/screen-shell';
import { VoxaText } from '../components/ui/voxa-text';
import { ChatEmptyState } from '../components/chat/chat-empty-state';
import { ChatInputBar } from '../components/chat/chat-input-bar';
import { TalkJumpToLatestButton } from '../components/chat/talk-jump-to-latest';
import { ChatMessageBubble } from '../components/chat/chat-message-bubble';
import { ChatToolsSheet } from '../components/chat/chat-tools-sheet';
import {
  beginComposerEdit,
  cancelComposerEdit,
  ComposerEditState,
  emptyEditMaySend,
} from '../services/chat/message-actions';
import { shouldApplyTalkMessageLoad } from '../services/chat/talk-load-apply';
import {
  beginTalkSend,
  clearExpiredTalkCooldowns,
  composerTextAfterFailedSend,
  createTalkSendGuard,
  endTalkSend,
  isStaleTalkRateLimitBanner,
  noteBurstRateLimit,
  recoverTimedOutTalkSend,
  resetTalkSendGuard,
} from '../services/chat/talk-send-guard';
import {
  isTalkListNearBottom,
  nextTalkJumpToLatestVisible,
  shouldPinTalkToLatest,
} from '../services/chat/talk-list-pin';
import { composerTextAfterDraftRestore, composerTextAfterStarterPrefill } from '../services/chat/talk-starter-prefill';
import { getCompanionMode } from '../constants/companion-modes';
import {
  ChatExperiencePayload,
  ContextCard,
  ConversationCanvas,
  LivingCompanionState,
  SmartChatAction,
} from '../types/phase4-intelligence';
import { ContextCardsRow } from '../components/phase4/context-cards-row';
import { ConversationCanvasCard } from '../components/phase4/conversation-canvas-card';
import { colors, layout, radius, spacing } from '../constants/theme';
import { isPaywallEnabled } from '../config/launch-mode';
import { useVoxa } from '../context/voxa-context';
import { MainTabParamList, RootStackParamList } from '../navigation/types';
import { FeatureLimitError } from '../services/billing/subscription-service';
import { getAIProviderInfo } from '../services/ai/create-ai-service';
import { warmAiGateway } from '../services/ai/ai-gateway-client';
import { formatTalkErrorForUser, TalkAIError, talkErrorRetryCanSucceed } from '../services/ai/talk-ai-errors';
import { friendlyErrorMessage } from '../utils/friendly-error';
import { toggleBookmark, listBookmarks, removeBookmark, ChatBookmark } from '../services/chat/chat-bookmarks-service';
import {
  buildConversationStarters,
  buildPostReplyStarters,
} from '../services/chat/conversation-starters-service';
import { getCompanionJournalService } from '../services/journal/companion-journal-service';
import { getRoutineCoachService } from '../services/routine/routine-coach-service';
import { voiceNotePlayerService } from '../services/audio/voice-note-player-service';
import {
  isCompanionSpeaking,
  shouldAutoSpeakReplies,
  speakCompanionReply,
  stopCompanionSpeech,
} from '../services/voice/companion-speech-service';
import { getSharedTts, getSpeechOwner, subscribeSpeechOwner } from '../services/voice/speech-playback-coordinator';
import { navigateToPaywall } from '../utils/paywall-navigation';
import { recordChatLatency } from '../utils/chat-debug-state';
import { logFeature } from '../utils/feature-logger';
import { talkPerf, talkPerfNow } from '../utils/talk-perf';
import { recordTiming } from '../utils/performance-metrics';
import { canStartLiveVoice, canStartSafeCall, openVoiceConversation } from '../utils/voice-navigation';
import { isFeatureVisible } from '../config/feature-status';
import { trackEvent } from '../services/analytics/analytics-service';
import {
  buildAudioMemoryRef,
  isMemoryPinned,
  sortMemoriesWithPinnedFirst,
  VOICE_MEMORY_TAG,
} from '../utils/memory-pinned';
import { ChatMessageView, CompanionModeId, PendingAttachmentInput, createUuid, toChatMessageView } from '../types';
import { getVoxaAvatarTint, getVoxaDisplayName } from '../utils/companion-display';
import { LiveCompanionOrb } from '../components/live-companion/live-companion-orb';
import { ChatDateSeparator, formatChatDateLabel } from '../components/phase7/chat-date-separator';
import { ChatContextChips } from '../components/phase7/chat-context-chips';
import { FocusModeBar } from '../components/phase9/focus-mode-bar';
import { buildChatContextChips } from '../services/phase7/chat-context-chips-service';
import { getFocusModeService } from '../services/phase9/focus-wake-service';
import { ComposerAction } from '../types/phase12-experiences';
import { FocusSession } from '../types/phase9-intelligence';

import { ResponseBlocks } from '../components/phase6/response-blocks';
import { MemoryPanel } from '../components/phase6/memory-panel';
import { THINKING_STATUS_LABELS } from '../types/phase6-premium';
import { buildMemoryPanel } from '../services/phase6/phase6-dashboard-service';
import { getConversationDraftsService } from '../services/phase6/conversation-drafts-service';
import { getPhotoMemoryService } from '../services/phase12/photo-memory-service';
import { RichReplyPayload } from '../types/phase6-premium';

function capSuggestions(items: string[], max = 3): string[] {
  return items.map((item) => item.trim()).filter(Boolean).slice(0, max);
}

function mergeChatViews(loaded: ChatMessageView[], inFlight: ChatMessageView[]): ChatMessageView[] {
  const byId = new Map<string, ChatMessageView>();
  for (const item of loaded) byId.set(item.id, item);
  for (const item of inFlight) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function messageSearchText(message: ChatMessageView): string {
  const parts = [message.text];
  for (const attachment of message.attachments ?? []) {
    if (attachment.transcription) parts.push(attachment.transcription);
    if (attachment.analysisSummary) parts.push(attachment.analysisSummary);
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function userMessageSendText(message: ChatMessageView): string {
  const audio = message.attachments?.find((item) => item.type === 'audio');
  if (audio?.transcription?.trim()) return audio.transcription.trim();
  return message.text?.trim() ?? '';
}

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Talk'>,
  NativeStackScreenProps<RootStackParamList>
>;

export function ChatScreen() {
  const route = useRoute<BottomTabScreenProps<MainTabParamList, 'Talk'>['route']>();
  const navigation = useNavigation<
    CompositeNavigationProp<
      BottomTabNavigationProp<MainTabParamList, 'Talk'>,
      NativeStackNavigationProp<RootStackParamList>
    >
  >();
  const { profile, companion, refreshProfile, services } = useVoxa();
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<CompanionModeId>(
    profile?.companion.lastUsedMode ?? profile?.companion.defaultMode ?? 'friend',
  );
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [thinkingStage, setThinkingStage] = useState(0);
  const [limitModalVisible, setLimitModalVisible] = useState(false);
  const [limitMessage, setLimitMessage] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [bookmarks, setBookmarks] = useState<ChatBookmark[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextCards, setContextCards] = useState<ContextCard[]>([]);
  const [smartActions, setSmartActions] = useState<SmartChatAction[]>([]);
  const [canvas, setCanvas] = useState<ConversationCanvas | null>(null);
  const [canvasExpanded, setCanvasExpanded] = useState(true);
  const [livingCompanion, setLivingCompanion] = useState<LivingCompanionState | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [memoryPanelItems, setMemoryPanelItems] = useState<import('../types/phase6-premium').MemoryPanelItem[]>([]);
  const [orbState, setOrbState] = useState<import('../components/live-companion/live-companion-orb').CompanionOrbState>('idle');
  const [orbMood, setOrbMood] = useState<import('../components/live-companion/live-companion-orb').CompanionOrbMood>('calm');
  const [contextChips, setContextChips] = useState<import('../components/phase7/chat-context-chips').ContextChip[]>([]);
  const [quickPrompts, setQuickPrompts] = useState<string[]>([]);
  const [focusSession, setFocusSession] = useState<FocusSession | null>(null);
  const [focusProgress, setFocusProgress] = useState(0);
  const [composerFavourites, setComposerFavourites] = useState<import('../types/phase12-experiences').ComposerActionId[]>([]);
  const [richReplies, setRichReplies] = useState<Record<string, RichReplyPayload>>({});
  const [chatEmptyGreeting, setChatEmptyGreeting] = useState('Hey there');
  const [chatEmptyLine, setChatEmptyLine] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [toolsSheetOpen, setToolsSheetOpen] = useState(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [composerEdit, setComposerEdit] = useState<ComposerEditState | null>(null);
  const pendingStarterRef = useRef<string | null>(null);
  const listRef = useRef<FlatList>(null);
  const messagesRef = useRef<ChatMessageView[]>([]);
  const loadedConversationRef = useRef<string | null>(null);
  const isTypingRef = useRef(false);
  const messagesLengthRef = useRef(0);
  const loadInFlightRef = useRef<Promise<void> | null>(null);
  const loadSeqRef = useRef(0);
  const sendEpochRef = useRef(0);
  const sendGuardRef = useRef(createTalkSendGuard());
  const thinkingStageInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const userReadingHistoryRef = useRef(false);
  const showJumpToLatestRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const pinTalkOnNextLayoutRef = useRef(true);
  const sendErrorCodeRef = useRef<string | null>(null);
  const sendErrorAtRef = useRef(0);
  const appActiveRef = useRef(true);
  const speechAlertAllowedRef = useRef(true);

  messagesLengthRef.current = messages.length;

  useEffect(() => {
    isTypingRef.current = isTyping;
  }, [isTyping]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    sendGuardRef.current = resetTalkSendGuard(sendGuardRef.current);
    sendErrorCodeRef.current = null;
    sendErrorAtRef.current = 0;
    setError(null);
    setIsTyping(false);
    setStreamingText(null);
    speechAlertAllowedRef.current = false;
    void stopCompanionSpeech();
    setIsSpeaking(false);
    setSpeakingMessageId(null);
    setCanvasExpanded(true);
  }, [profile?.id]);

  useEffect(() => {
    if (!isSpeaking) return;
    const timer = setInterval(() => {
      if (getSpeechOwner() === 'idle' && !getSharedTts().isSpeaking()) {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      }
    }, 400);
    return () => clearInterval(timer);
  }, [isSpeaking]);

  useEffect(() => {
    if (!thinkingStageInterval.current && isTyping) {
      thinkingStageInterval.current = setInterval(() => {
        setThinkingStage((s) => (s + 1) % THINKING_STATUS_LABELS.length);
      }, 2400);
    }
    if (!isTyping && thinkingStageInterval.current) {
      clearInterval(thinkingStageInterval.current);
      thinkingStageInterval.current = null;
    }
    return () => {
      if (thinkingStageInterval.current) clearInterval(thinkingStageInterval.current);
    };
  }, [isTyping]);

  useEffect(() => {
    if (!profile || !conversationId) return;
    void getConversationDraftsService(services.storage).get(profile.id, conversationId).then((draft) => {
      if (!draft && !pendingStarterRef.current) return;
      setInput((current) => {
        const result = composerTextAfterDraftRestore({
          currentComposer: current,
          draft,
          pendingStarter: pendingStarterRef.current,
        });
        if (result.clearStarter) pendingStarterRef.current = null;
        return result.nextComposer;
      });
    });
  }, [profile?.id, conversationId]);

  useEffect(() => {
    if (!profile || !conversationId) return;
    const timer = setTimeout(() => {
      void getConversationDraftsService(services.storage).save(profile.id, conversationId, input);
    }, 400);
    return () => clearTimeout(timer);
  }, [input, profile?.id, conversationId, services.storage]);

  useEffect(() => {
    if (!profile) return;
    void companion.getHomeDashboard(profile.id).then((d) => {
      setMemoryPanelItems(
        buildMemoryPanel({
          memories: d.memories,
          goals: d.activeGoals,
          routine: d.routineSummary,
          journalInsight: d.phase2.dailyCoach.focus,
        }),
      );
      const living = d.phase7.livingCompanion;
      setOrbMood(living.mood);
      setOrbState(living.state);
      setContextChips(
        buildChatContextChips({
          goals: d.activeGoals,
          memories: d.memories,
          routine: d.routineSummary,
          thinkingAbout: d.phase4.livingCompanion.thinkingAbout,
        }).filter((chip) => chip.label.trim().length > 0),
      );
    });
  }, [profile, companion]);

  useEffect(() => {
    if (isTyping) setOrbState('thinking');
  }, [isTyping]);

  useEffect(() => {
    if (route.params?.conversationId) return;
    const mode = profile?.companion.lastUsedMode ?? profile?.companion.defaultMode;
    if (mode) setActiveMode(mode);
  }, [profile?.companion.lastUsedMode, profile?.companion.defaultMode, route.params?.conversationId]);

  const loadChat = useCallback(async (force = false) => {
    if (!profile) {
      setIsLoading(false);
      return;
    }
    if (!force && isTypingRef.current) return;
    if (!force && loadInFlightRef.current) return loadInFlightRef.current;

    const run = async () => {
      const loadSeq = ++loadSeqRef.current;
      const sendEpochAtLoadStart = sendEpochRef.current;
      const paramConversationId = route.params?.conversationId;
      const mode = profile.companion.lastUsedMode ?? profile.companion.defaultMode ?? 'friend';
      setActiveMode(mode);
      const loadStarted = Date.now();
      logFeature('chat.load', 'start');
      try {
        let conversation;
        if (paramConversationId) {
          conversation = await services.repositories.conversations.getConversation(paramConversationId);
          if (!conversation) {
            setLoadError('Conversation not found.');
            setIsLoading(false);
            return;
          }
          setActiveMode(conversation.mode);
        }
        if (!conversation) {
          const listed = await services.repositories.conversations.listConversations(profile.id);
          const recentChat = listed.find((item) => item.channel === 'chat' && item.status === 'active');
          conversation =
            recentChat ?? (await companion.getOrCreateConversation(profile.id, mode, 'chat'));
        }
        if (!force && loadedConversationRef.current === conversation.id && messagesLengthRef.current > 0) {
          setConversationId(conversation.id);
          setIsLoading(false);
          return;
        }
        setIsLoading(true);
        setLoadError(null);
        const loadedMessages = await companion.loadChatMessages(conversation.id);
        setConversationId(conversation.id);
        if (
          shouldApplyTalkMessageLoad({
            loadSeq,
            currentLoadSeq: loadSeqRef.current,
            sendEpochAtLoadStart,
            currentSendEpoch: sendEpochRef.current,
            sendInFlight: sendGuardRef.current.inFlight || isTypingRef.current,
          })
        ) {
          setMessages((current) => {
            const inFlight = current.filter(
              (item) => item.status === 'pending' || item.status === 'failed',
            );
            return mergeChatViews(loadedMessages, inFlight);
          });
          loadedConversationRef.current = conversation.id;
        }
        setIsLoading(false);
        void companion.getChatExperience(profile.id, conversation.id).then((experience) => {
          if (!experience) return;
          setContextCards(experience.contextCards);
          setLivingCompanion(experience.livingCompanion);
          setCanvas(experience.canvas);
        }).catch(() => undefined);
        logFeature('chat.load', 'success', undefined, Date.now() - loadStarted);
        recordTiming('chat.load', Date.now() - loadStarted);
      } catch (err) {
        logFeature('chat.load', 'failure', err instanceof Error ? err.message : 'Failed to load chat.', Date.now() - loadStarted);
        setLoadError(friendlyErrorMessage(err, "Couldn't open this conversation. Try again."));
      } finally {
        setIsLoading(false);
      }
    };

    const pending = run().finally(() => {
      loadInFlightRef.current = null;
    });
    loadInFlightRef.current = pending;
    return pending;
  }, [companion, profile, route.params?.conversationId, services.repositories.conversations]);

  useFocusEffect(
    useCallback(() => {
      if (!isTypingRef.current) {
        void loadChat();
      }
      return () => {
        speechAlertAllowedRef.current = false;
        void stopCompanionSpeech();
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      };
    }, [loadChat]),
  );

  const playCompanionText = useCallback(
    async (text: string, messageId?: string) => {
      if (!profile || !isFeatureVisible('playAloud')) return;
      const cleaned = text.trim();
      if (!cleaned) return;
      speechAlertAllowedRef.current = true;
      setIsSpeaking(true);
      setSpeakingMessageId(messageId ?? null);
      try {
        await speakCompanionReply(cleaned, profile, { messageId });
      } catch {
        if (speechAlertAllowedRef.current && appActiveRef.current) {
          Alert.alert('Playback failed', 'Could not play this message aloud.');
        }
      } finally {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      }
    },
    [profile],
  );

  const toggleAutoSpeak = useCallback(async () => {
    if (!profile) return;
    const next = profile.preferences.voxaSpeaksReplies === false;
    await services.repositories.userProfile.updateProfile({
      preferences: { ...profile.preferences, voxaSpeaksReplies: next },
    });
    await refreshProfile();
    if (!next) {
      await stopCompanionSpeech();
      setIsSpeaking(false);
      setSpeakingMessageId(null);
    }
  }, [profile, refreshProfile, services.repositories.userProfile]);

  useEffect(() => {
    const sub = subscribeSpeechOwner(() => {
      if (getSpeechOwner() === 'idle' && !getSharedTts().isSpeaking()) {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      }
    });
    return sub;
  }, []);

  useEffect(() => {
    const resetTransientTalkState = (reason: 'background' | 'foreground') => {
      speechAlertAllowedRef.current = false;
      void stopCompanionSpeech();
      setIsSpeaking(false);
      setSpeakingMessageId(null);
      const timedOut = recoverTimedOutTalkSend(sendGuardRef.current);
      if (timedOut || (reason === 'foreground' && sendGuardRef.current.inFlight === false && isTypingRef.current)) {
        setIsTyping(false);
        setStreamingText(null);
      }
      const expired = clearExpiredTalkCooldowns(sendGuardRef.current);
      if (
        expired ||
        isStaleTalkRateLimitBanner({
          code: sendErrorCodeRef.current,
          shownAt: sendErrorAtRef.current,
        })
      ) {
        sendErrorCodeRef.current = null;
        sendErrorAtRef.current = 0;
        setError(null);
      }
      if (reason === 'foreground') {
        pinTalkOnNextLayoutRef.current = true;
      }
    };

    const onChange = (next: AppStateStatus) => {
      const active = next === 'active';
      const wasActive = appActiveRef.current;
      appActiveRef.current = active;
      if (!active) {
        resetTransientTalkState('background');
        return;
      }
      if (!wasActive && active) {
        resetTransientTalkState('foreground');
      }
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  const pinTalkToLatest = useCallback((reason: 'load' | 'send' | 'reply' | 'typing' | 'foreground') => {
    if (
      !shouldPinTalkToLatest({
        userReadingHistory: userReadingHistoryRef.current,
        reason,
      })
    ) {
      return;
    }
    showJumpToLatestRef.current = false;
    setShowJumpToLatest(false);
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: reason !== 'load' && reason !== 'foreground' });
    });
  }, []);

  const jumpToLatest = useCallback(() => {
    userReadingHistoryRef.current = false;
    showJumpToLatestRef.current = false;
    setShowJumpToLatest(false);
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  useEffect(() => {
    if (messages.length === 0) return;
    pinTalkToLatest(isTyping ? 'typing' : 'reply');
  }, [messages.length, isTyping, pinTalkToLatest]);

  useEffect(() => {
    if (!isTyping && !error) return;
    const timer = setInterval(() => {
      if (recoverTimedOutTalkSend(sendGuardRef.current)) {
        setIsTyping(false);
        setStreamingText(null);
        sendErrorCodeRef.current = 'request_timeout';
        sendErrorAtRef.current = Date.now();
        setError(new TalkAIError('request_timeout').userMessage);
        setMessages((current) =>
          current.map((item) =>
            item.role === 'user' && item.status === 'pending' ? { ...item, status: 'failed' as const } : item,
          ),
        );
      }
      if (
        isStaleTalkRateLimitBanner({
          code: sendErrorCodeRef.current,
          shownAt: sendErrorAtRef.current,
        })
      ) {
        sendErrorCodeRef.current = null;
        sendErrorAtRef.current = 0;
        setError(null);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [isTyping, error]);

  useEffect(() => {
    if (!isTyping || streamingText) return;
    const timer = setInterval(() => {
      setThinkingStage((s) => (s + 1) % THINKING_STATUS_LABELS.length);
    }, 1400);
    return () => clearInterval(timer);
  }, [isTyping, streamingText]);

  useEffect(() => {
    if (!profile || messages.length > 0) return;
    void (async () => {
      const [goals, memories, journal] = await Promise.all([
        services.repositories.goals.listActiveGoals(profile.id),
        services.repositories.memories.listMemories(profile.id),
        getCompanionJournalService(services.storage, services.repositories).getTodayEntry(),
      ]);
      const routine = await getRoutineCoachService(services.storage, services.repositories).getTodaySchedule(
        profile.id,
      );
      const sorted = sortMemoriesWithPinnedFirst(memories);
      const dashboard = await companion.getHomeDashboard(profile.id).catch(() => null);
      if (dashboard?.phase4.contextCards.length) {
        setContextCards(dashboard.phase4.contextCards);
      }
      if (dashboard?.phase4.livingCompanion) {
        setLivingCompanion(dashboard.phase4.livingCompanion);
      }
      setSuggestions(
        capSuggestions(
          buildConversationStarters({
            profile,
            routine,
            activeGoals: goals,
            latestJournal: journal,
            recentMoodLabel: dashboard?.wowExperience.moodLabel ?? null,
            continuePreview: dashboard?.wowExperience.continueConversation?.preview ?? null,
            pinnedMemories: sorted.filter((memory) => isMemoryPinned(memory)),
            recentMemory: sorted[0] ?? null,
            calendar: dashboard?.phase8.calendar ?? null,
            dailyPlan: dashboard?.phase9.dailyPlan ?? null,
            relationshipIntel: dashboard?.phase9.relationshipIntel ?? null,
            premiumStarters: dashboard?.phase9.quickPrompts,
          }),
        ),
      );
      if (dashboard?.phase9.quickPrompts) setQuickPrompts(dashboard.phase9.quickPrompts);
      if (dashboard?.phase11) {
        setChatEmptyGreeting(dashboard.phase11.rhythm.greeting);
        setChatEmptyLine(dashboard.phase11.emotionalMessage);
        setOrbMood(dashboard.phase11.mood);
      }
      if (dashboard?.phase12?.composerPrefs) {
        setComposerFavourites(dashboard.phase12.composerPrefs.favouriteActionIds);
      }
      if (dashboard?.phase9.activeFocus && profile) {
        setFocusSession(dashboard.phase9.activeFocus);
        setFocusProgress(getFocusModeService(services.storage).progressPercent(dashboard.phase9.activeFocus));
      }
    })();
  }, [profile, messages.length, services, companion]);

  useEffect(() => () => {
    void voiceNotePlayerService.stop();
  }, []);

  useFocusEffect(
    useCallback(() => {
      warmAiGateway();
      void listBookmarks().then(setBookmarks);
    }, []),
  );

  const sendMessage = async (
    attachments: PendingAttachmentInput[] = [],
    overrideText?: string,
    options?: { retryMessage?: ChatMessageView },
  ) => {
    const sendTapAt = talkPerfNow();
    const retryMessage = options?.retryMessage;
    const trimmed = (overrideText ?? retryMessage?.text ?? input).trim();
    if (composerEdit && !emptyEditMaySend(trimmed) && attachments.length === 0) return false;
    if ((!trimmed && attachments.length === 0) || !profile || !conversationId) return false;

    recoverTimedOutTalkSend(sendGuardRef.current);
    clearExpiredTalkCooldowns(sendGuardRef.current);

    const fingerprintText = trimmed || `[attachment:${attachments.length}]`;
    const decision = beginTalkSend(sendGuardRef.current, {
      text: fingerprintText,
      conversationId,
      isRetry: Boolean(retryMessage),
    });
    if (!decision.accepted) {
      if (decision.reason === 'in_flight' && overrideText?.trim()) {
        setInput((current) => (current.trim() ? current : overrideText.trim()));
      }
      if (decision.reason === 'burst_cooldown') {
        setError(new TalkAIError('rate_limited').userMessage);
      }
      return false;
    }

    sendEpochRef.current += 1;
    userReadingHistoryRef.current = false;
    showJumpToLatestRef.current = false;
    setShowJumpToLatest(false);
    pinTalkOnNextLayoutRef.current = true;

    const idsAtStart = new Set(messagesRef.current.map((item) => item.id));
    setComposerEdit(null);
    if (!retryMessage) setInput('');
    setSuggestions([]);
    setSuggestionsDismissed(false);
    setIsTyping(true);
    setStreamingText(null);
    setThinkingStage(0);
    setError(null);
    sendErrorCodeRef.current = null;
    void stopCompanionSpeech();
    setIsSpeaking(false);
    setSpeakingMessageId(null);

    const optimisticId = retryMessage?.id ?? createUuid();
    if (retryMessage) {
      setMessages((current) =>
        current.map((item) => (item.id === retryMessage.id ? { ...item, status: 'pending' } : item)),
      );
    } else {
      const optimisticMessage: ChatMessageView = {
        id: optimisticId,
        role: 'user',
        text: trimmed || (attachments.length ? 'Sent an attachment' : ''),
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        createdAt: new Date().toISOString(),
        status: 'pending',
        attachments: attachments.length
          ? attachments.map((item, index) => ({
              id: `pending-${index}`,
              type: item.type,
              localUri: item.localUri,
              mimeType: item.mimeType,
              fileName: item.fileName,
              uploadStatus: 'uploading' as const,
              createdAt: new Date().toISOString(),
            }))
          : undefined,
      };
      setMessages((current) => [...current, optimisticMessage]);
    }
    pinTalkToLatest('send');
    talkPerf('local-ui', talkPerfNow() - sendTapAt);
    talkPerf('thinking', talkPerfNow() - sendTapAt);
    talkPerf('conversation-ready', 0);
    const started = Date.now();
    let assistantVisible = false;
    logFeature('chat.send', 'start');

    try {
      const result = await companion.sendChatMessage(
        {
          userId: profile.id,
          conversationId,
          content: trimmed,
          mode: activeMode,
          attachments: attachments.length > 0 ? attachments : undefined,
          loadedProfile: profile,
          recentHistory: chatViewsToHistory(
            messagesRef.current.filter((item) => item.id !== optimisticId),
            conversationId,
            activeMode,
          ),
          existingUserMessage: retryMessage
            ? {
                id: retryMessage.id,
                conversationId,
                role: 'user',
                content: trimmed,
                mode: activeMode,
                createdAt: retryMessage.createdAt,
                status: 'pending',
                attachments: retryMessage.attachments,
              }
            : undefined,
        },
        {
          onStreamChunk: (chunk) => setStreamingText((current) => (current ?? '') + chunk),
          onAssistantReady: ({ userMessage, voxaMessage }) => {
            assistantVisible = true;
            setMessages((current) => {
              const withoutOptimistic = current.filter((item) => item.id !== optimisticId);
              if (withoutOptimistic.some((item) => item.id === voxaMessage.id)) {
                return withoutOptimistic;
              }
              return [
                ...withoutOptimistic,
                toChatMessageView(userMessage),
                toChatMessageView(voxaMessage),
              ];
            });
            talkPerf('render', talkPerfNow() - sendTapAt);
            talkPerf('total-visible-response', talkPerfNow() - sendTapAt);
            setIsTyping(false);
            setStreamingText(null);
          },
        },
      );

      if (result.sideEffect?.type === 'switch_mode') {
        setActiveMode(result.sideEffect.mode);
        setConversationId(result.sideEffect.conversationId);
        loadedConversationRef.current = result.sideEffect.conversationId;
        await refreshProfile();
      }

      if (result.voxaMessage.mode) {
        setActiveMode(result.voxaMessage.mode);
      }

      if (result.chatExperience) {
        setSmartActions(result.chatExperience.smartActions);
        setCanvas(result.chatExperience.canvas);
        if (result.chatExperience.contextCards.length > 0) {
          setContextCards(result.chatExperience.contextCards);
        }
        if (result.chatExperience.livingCompanion.greeting) {
          setLivingCompanion(result.chatExperience.livingCompanion);
        }
      }

      if (result.richReply) {
        setRichReplies((prev) => ({ ...prev, [result.voxaMessage.id]: result.richReply! }));
      }

      if (profile && conversationId) {
        void getConversationDraftsService(services.storage).clear(profile.id, conversationId);
      }

      setMessages((current) => {
        if (current.some((item) => item.id === result.voxaMessage.id)) {
          return current.map((item) =>
            item.id === result.userMessage.id || item.id === result.voxaMessage.id
              ? toChatMessageView(item.id === result.userMessage.id ? result.userMessage : result.voxaMessage)
              : item,
          );
        }
        const withoutOptimistic = current.filter((m) => m.id !== optimisticId);
        return [
          ...withoutOptimistic,
          toChatMessageView(result.userMessage),
          toChatMessageView(result.voxaMessage),
        ];
      });

      recordChatLatency(Date.now() - started, getAIProviderInfo().label);
      recordTiming('chat.send', Date.now() - started);
      logFeature('chat.send', 'success', undefined, Date.now() - started);
      trackEvent('message_sent');
      const reply = result.voxaMessage.content;
      if (
        reply &&
        isFeatureVisible('playAloud') &&
        shouldAutoSpeakReplies(profile)
      ) {
        void playCompanionText(reply, result.voxaMessage.id);
      }
      setSuggestions(
        capSuggestions(
          resolveTurnSuggestionPrompts({
            contextual: result.phase9Suggestions,
            fallback: reply ? buildPostReplyStarters(reply, activeMode) : [],
          }),
        ),
      );
      setSuggestionsDismissed(false);

      if (result.sideEffect?.type === 'open_voice_conversation') {
        const stackNav = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>();
        const allowed = result.sideEffect.safe ? canStartSafeCall() : canStartLiveVoice();
        if (stackNav && allowed) {
          openVoiceConversation(stackNav, {
            safe: result.sideEffect.safe,
            autoStart: result.sideEffect.autoStart,
          });
        }
      }
    } catch (err) {
      let persistedNewUserTurn = Boolean(retryMessage);
      if (!assistantVisible) {
        try {
          const reloaded = await companion.loadChatMessages(conversationId);
          const persisted = reloaded.find(
            (item) =>
              item.role === 'user' &&
              item.text === trimmed &&
              (item.id === optimisticId || retryMessage?.id === item.id || !idsAtStart.has(item.id)),
          );
          persistedNewUserTurn = Boolean(persisted);
          if (persisted) {
            setMessages(
              reloaded.map((item) => (item.id === persisted.id ? { ...item, status: 'failed' as const } : item)),
            );
          } else {
            setMessages(reloaded.filter((item) => item.id !== optimisticId));
          }
        } catch {
          setMessages((current) =>
            current.map((item) => (item.id === optimisticId ? { ...item, status: 'failed' as const } : item)),
          );
          persistedNewUserTurn = true;
        }
      }
      setInput((current) =>
        composerTextAfterFailedSend({
          sentText: trimmed,
          persistedNewUserTurn,
          currentComposer: current,
        }),
      );
      logFeature('chat.send', 'failure', err instanceof Error ? err.message : 'send failed', Date.now() - started);
      if (err instanceof TalkAIError && err.code === 'rate_limited') {
        noteBurstRateLimit(sendGuardRef.current);
        sendErrorCodeRef.current = 'rate_limited';
        sendErrorAtRef.current = Date.now();
      } else {
        sendErrorCodeRef.current = err instanceof TalkAIError ? err.code : 'gateway_error';
        sendErrorAtRef.current = Date.now();
      }
      if (err instanceof FeatureLimitError && isPaywallEnabled()) {
        trackEvent('free_limit_reached', { feature: err.feature });
        void services.subscriptionAnalytics.track('free_limit_reached', { feature: err.feature });
        setLimitMessage(err.message);
        setLimitModalVisible(true);
      } else if (err instanceof FeatureLimitError) {
        setError(err.message);
      } else {
        setError(formatTalkErrorForUser(err));
      }
    } finally {
      endTalkSend(sendGuardRef.current);
      setIsTyping(false);
      setStreamingText(null);
    }
    return true;
  };

  const retryAttachmentUpload = useCallback(
    async (messageId: string, attachmentId: string) => {
      if (!profile || !conversationId) return;
      try {
        await companion.retryMessageAttachmentUpload({
          userId: profile.id,
          conversationId,
          messageId,
          attachmentId,
        });
        const updatedMessages = await companion.loadChatMessages(conversationId);
        setMessages((current) => {
          const inFlight = current.filter(
            (item) => item.status === 'pending' || item.status === 'failed',
          );
          return mergeChatViews(updatedMessages, inFlight);
        });
      } catch (err) {
        setError(formatTalkErrorForUser(err));
      }
    },
    [profile, conversationId, companion],
  );

  useEffect(() => {
    const paramConversationId = route.params?.conversationId;
    if (!paramConversationId) return;
    if (loadedConversationRef.current === paramConversationId) return;
    void loadChat(true);
    navigation.setParams({ conversationId: undefined } as MainTabParamList['Talk']);
  }, [route.params?.conversationId, loadChat, navigation]);

  useEffect(() => {
    const starter = route.params?.starterPrompt;
    if (!starter?.trim()) return;
    pendingStarterRef.current = starter.trim();
    if (route.params?.mode) setActiveMode(route.params.mode);
    navigation.setParams({ starterPrompt: undefined, mode: undefined } as MainTabParamList['Talk']);
    setInput((current) => {
      const { nextComposer, consumed } = composerTextAfterStarterPrefill({
        pendingStarter: starter,
        currentComposer: current,
      });
      if (consumed) pendingStarterRef.current = null;
      return nextComposer;
    });
  }, [route.params?.starterPrompt, route.params?.mode, navigation]);

  const rememberMessage = useCallback(
    async (message: ChatMessageView) => {
      const audio = message.attachments?.find((item) => item.type === 'audio');
      const text = audio?.transcription?.trim() || message.text.trim();
      if (!profile || !text) return;
      try {
        await services.repositories.memories.createMemory({
          userId: profile.id,
          category: 'moments',
          title: audio ? 'Voice note' : 'Remember this',
          content: text,
          importance: 5,
          emotionalSignificance: 5,
          tags: ['remember-this', message.role, ...(audio ? [VOICE_MEMORY_TAG] : [])],
          source: audio ? 'audio' : 'conversation',
          relatedMode: activeMode,
          occurredAt: new Date().toISOString(),
        });
        if (audio) {
          const { getAchievementTriggersService } = await import('../services/phase10/achievement-triggers-service');
          void getAchievementTriggersService(services.storage).onVoiceNoteSaved(profile.id);
        }
        Alert.alert('Saved', 'Voxa will remember this moment.');
      } catch (err) {
        Alert.alert('Could not save', err instanceof Error ? err.message : 'Try again.');
      }
    },
    [profile, services.repositories.memories, services.storage, activeMode],
  );

  const voxaTint = profile ? getVoxaAvatarTint(profile) : colors.primary;

  const handlePlayAloud = useCallback(
    async (message: ChatMessageView) => {
      if (!profile) return;
      if (isCompanionSpeaking() && speakingMessageId === message.id) {
        speechAlertAllowedRef.current = false;
        await stopCompanionSpeech();
        setIsSpeaking(false);
        setSpeakingMessageId(null);
        return;
      }
      const audio = message.attachments?.find((item) => item.type === 'audio');
      const text = audio?.transcription?.trim() || message.text?.trim();
      if (!text) return;
      await playCompanionText(text, message.id);
    },
    [profile, playCompanionText, speakingMessageId],
  );

  const handleCopyTranscript = useCallback(async (message: ChatMessageView) => {
    const audio = message.attachments?.find((item) => item.type === 'audio');
    const text = audio?.transcription?.trim() || message.text?.trim();
    if (!text) return;
    await Share.share({ message: text });
  }, []);

  const handleSaveVoiceMemory = useCallback(
    async (message: ChatMessageView) => {
      if (!profile) return;
      const audio = message.attachments?.find((item) => item.type === 'audio');
      const transcript = audio?.transcription?.trim();
      if (!transcript) {
        Alert.alert('No transcript', 'This voice note does not have a transcript yet.');
        return;
      }
      try {
        await services.repositories.memories.createMemory({
          userId: profile.id,
          category: 'moments',
          title: 'Voice memory',
          content: transcript,
          importance: 5,
          emotionalSignificance: 4,
          tags: [VOICE_MEMORY_TAG, buildAudioMemoryRef(audio!.id)],
          source: 'audio',
          relatedMode: activeMode,
          occurredAt: new Date().toISOString(),
        });
        Alert.alert('Saved', 'Voice memory added to Journey.');
      } catch (err) {
        Alert.alert('Could not save', err instanceof Error ? err.message : 'Try again.');
      }
    },
    [profile, services.repositories.memories, activeMode],
  );

  const handleBookmark = useCallback(
    async (message: ChatMessageView) => {
      if (!conversationId || !message.text) return;
      try {
        await toggleBookmark({
          messageId: message.id,
          conversationId,
          text: message.text,
          role: message.role,
        });
        setBookmarks(await listBookmarks());
      } catch (err) {
        Alert.alert('Bookmark failed', err instanceof Error ? err.message : 'Could not save bookmark.');
      }
    },
    [conversationId],
  );

  const handleDelete = useCallback(
    async (message: ChatMessageView) => {
      try {
        await services.repositories.messages.deleteMessage(message.id);
        await removeBookmark(message.id);
        setMessages((current) => current.filter((m) => m.id !== message.id));
        setBookmarks(await listBookmarks());
      } catch {
        Alert.alert('Delete failed', 'Could not remove this message.');
      }
    },
    [services.repositories.messages],
  );

  // Deferred: current regenerate deletes the Voxa row then re-sends the prior
  // user text, which would persist a duplicate user message. Not in the V1 menu.
  const handleRegenerate = useCallback(
    async (voxaMessage: ChatMessageView) => {
      const index = messages.findIndex((m) => m.id === voxaMessage.id);
      if (index <= 0) return;
      const priorUser = [...messages.slice(0, index)].reverse().find((m) => m.role === 'user');
      const sendText = priorUser ? userMessageSendText(priorUser) : '';
      if (!sendText) return;
      try {
        await services.repositories.messages.deleteMessage(voxaMessage.id);
        setMessages((current) => current.filter((m) => m.id !== voxaMessage.id));
        await sendMessage([], sendText);
      } catch (err) {
        Alert.alert('Regenerate failed', err instanceof Error ? err.message : 'Could not regenerate reply.');
      }
    },
    [messages, services.repositories.messages, sendMessage],
  );

  const handleEdit = useCallback((message: ChatMessageView) => {
    const text = message.text?.trim();
    if (!text) return;
    setComposerEdit(
      beginComposerEdit({
        messageId: message.id,
        messageText: text,
        currentComposer: input,
      }),
    );
    setInput(text);
  }, [input]);

  const handleCancelEdit = useCallback(() => {
    if (!composerEdit) {
      setComposerEdit(null);
      return;
    }
    setInput(cancelComposerEdit(composerEdit).composer);
    setComposerEdit(null);
  }, [composerEdit]);

  const handleRetrySend = useCallback(
    async (message: ChatMessageView) => {
      const text = userMessageSendText(message);
      if (!text) return;
      await sendMessage([], text, { retryMessage: message });
    },
    [sendMessage],
  );

  const startNewConversation = async () => {
    if (!profile) return;
    try {
      const conv = await services.repositories.conversations.createConversation({
        userId: profile.id,
        mode: activeMode,
        channel: 'chat',
        title: 'New chat',
      });
      setConversationId(conv.id);
      loadedConversationRef.current = conv.id;
      setMessages([]);
      setSuggestions(capSuggestions([
        `Hey ${profile.displayName.split(' ')[0]}, what's on your mind?`,
        'Help me plan today',
        'I need to talk',
      ]));
    } catch (err) {
      Alert.alert('Could not start chat', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const handleSavePhotoMemory = useCallback(
    async (message: ChatMessageView) => {
      if (!profile) return;
      const image = message.attachments?.find((a) => a.type === 'image');
      const summary =
        image?.analysisSummary ??
        message.text?.trim() ??
        'A meaningful photo moment';
      try {
        const localUri = image?.localUri;
        const remoteUrl = image?.remoteUrl;
        const photos = getPhotoMemoryService(services.storage);
        const existing = await photos.findExisting(profile.id, {
          localUri,
          remoteUrl,
        });
        if (existing) {
          Alert.alert('Saved', 'Photo memory added to Journey.');
          return;
        }
        const memory = await services.repositories.memories.createMemory({
          userId: profile.id,
          category: 'moments',
          title: 'Photo memory',
          content: summary,
          importance: 5,
          emotionalSignificance: 4,
          tags: ['photo-memory', message.role],
          source: 'image',
          relatedMode: activeMode,
          occurredAt: new Date().toISOString(),
        });
        if (localUri || remoteUrl) {
          await photos.create(profile.id, {
            title: 'Photo memory',
            caption: summary,
            localUri,
            remoteUrl,
            thumbnailUri: image?.thumbnailUri,
            occurredAt: memory.occurredAt ?? new Date().toISOString(),
            category: 'everyday',
            people: [],
            isPrivate: false,
            pinned: false,
            favourite: false,
            analysisSummary: image?.analysisSummary,
            memoryId: memory.id,
          });
        }
        Alert.alert('Saved', 'Photo memory added to Journey.');
      } catch (err) {
        Alert.alert('Could not save', err instanceof Error ? err.message : 'Try again.');
      }
    },
    [profile, services.repositories.memories, services.storage, activeMode],
  );

  const searchResults = searchQuery.trim()
    ? messages.filter((m) => messageSearchText(m).includes(searchQuery.toLowerCase()))
    : [];

  const renderMessage = useCallback(
    ({ item, index }: { item: ChatMessageView; index: number }) => {
      const prev = index > 0 ? messagesRef.current[index - 1] : undefined;
      const showDate =
        !prev || formatChatDateLabel(item.createdAt) !== formatChatDateLabel(prev.createdAt);
      const showAvatar = item.role !== 'user' && (!prev || prev.role === 'user' || showDate);
      const richReply = richReplies[item.id];
      return (
        <View>
          {showDate ? <ChatDateSeparator label={formatChatDateLabel(item.createdAt)} /> : null}
          <ChatMessageBubble
            message={item}
            voxaTint={voxaTint}
            voxaName={profile ? getVoxaDisplayName(profile) : 'Voxa'}
            showAvatar={showAvatar}
            bookmarked={bookmarks.some((b) => b.messageId === item.id)}
            isSpeaking={speakingMessageId === item.id}
            onRetryUpload={(attachmentId) => void retryAttachmentUpload(item.id, attachmentId)}
            onRemember={(message) => void rememberMessage(message)}
            onBookmark={(message) => void handleBookmark(message)}
            onDelete={(message) => void handleDelete(message)}
            onRetrySend={(message) => void handleRetrySend(message)}
            onEdit={handleEdit}
            onPlayAloud={(message) => void handlePlayAloud(message)}
            onSavePhotoMemory={(message) => void handleSavePhotoMemory(message)}
            onSaveVoiceMemory={(message) => void handleSaveVoiceMemory(message)}
            onCopyTranscript={(message) => void handleCopyTranscript(message)}
          />
          {item.role === 'voxa' && richReply?.blocks?.length ? (
            <ResponseBlocks blocks={richReply.blocks} />
          ) : null}
        </View>
      );
    },
    [
      voxaTint,
      profile,
      bookmarks,
      rememberMessage,
      retryAttachmentUpload,
      handleBookmark,
      handleDelete,
      handleRetrySend,
      handleEdit,
      handlePlayAloud,
      handleSavePhotoMemory,
      handleSaveVoiceMemory,
      handleCopyTranscript,
      richReplies,
      speakingMessageId,
    ],
  );

  const scrollToMessage = (messageId: string) => {
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    setSearchOpen(false);
    setSearchQuery('');
    setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 120);
  };

  const handleContextCard = (card: ContextCard) => {
    void sendMessage([], card.prompt);
  };

  const handleSmartAction = async (action: SmartChatAction) => {
    if (!profile || !conversationId || isTyping) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastVoxa = [...messages].reverse().find((m) => m.role === 'voxa');
    const sourceText = lastUser ? userMessageSendText(lastUser) : '';
    const result = await companion.executeSmartChatAction({
      userId: profile.id,
      conversationId,
      action,
      mode: activeMode,
      sourceText: action.payload?.text ?? sourceText,
      messageId: lastVoxa?.id,
    });
    setActionFeedback(result.message);
    if (action.id === 'explain_differently') {
      void sendMessage([], 'Explain that differently');
    } else if (action.id === 'challenge_thinking') {
      void sendMessage([], 'Challenge my thinking on this');
    } else if (action.id === 'break_into_tasks') {
      void sendMessage([], 'Break this into tasks for me');
    }
    setTimeout(() => setActionFeedback(null), 4000);
  };

  const handleComposerAction = (action: ComposerAction) => {
    if (action.navigateTo === 'FocusMode') {
      navigation.navigate('FocusMode');
      return;
    }
    if (action.navigateTo === 'CreateReminder') {
      navigation.navigate('CreateReminder');
      return;
    }
    if (action.navigateTo === 'ScheduledCheckIns') {
      navigation.navigate('ScheduledCheckIns');
      return;
    }
    if (action.navigateTo === 'CompanionChallenges') {
      navigation.navigate('CompanionChallenges');
      return;
    }
    if (action.navigateTo === 'ConversationWorlds') {
      navigation.navigate('ConversationWorlds');
      return;
    }
    void sendMessage([], action.instruction);
  };

  const keyExtractor = useCallback((item: ChatMessageView) => item.id, []);

  if (isLoading) {
    return (
      <ScreenShell padded={false} glow="none" safeBottom={false}>
        <LoadingState label="Opening conversation..." />
      </ScreenShell>
    );
  }

  if (loadError && messages.length === 0) {
    return (
      <ScreenShell padded={false} glow="none" safeBottom={false}>
        <ErrorState message={loadError} onRetry={() => loadChat(true)} />
      </ScreenShell>
    );
  }

  const voxaName = getVoxaDisplayName(profile);
  const headerOrbState = isTyping ? 'thinking' : isSpeaking ? 'speaking' : orbState;
  const autoSpeakOn = profile?.preferences.voxaSpeaksReplies !== false;

  const statusLabel = isTyping
    ? THINKING_STATUS_LABELS[thinkingStage] ?? 'Thinking…'
    : isSpeaking
      ? 'Speaking…'
      : getCompanionMode(activeMode).shortLabel;

  return (
    <ScreenShell padded={false} glow="none" safeBottom={false}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}>
        <View style={styles.header}>
          <View style={styles.avatar}>
            <LiveCompanionOrb size={28} tint={voxaTint} active mood={orbMood} state={headerOrbState} intensity={0.4} />
          </View>
          <View style={styles.headerCopy}>
            <VoxaText variant="subtitle" style={styles.headerTitle}>
              {voxaName}
            </VoxaText>
            <VoxaText variant="caption" color="textMuted" style={styles.headerStatus} numberOfLines={1}>
              {statusLabel}
            </VoxaText>
          </View>
          <View style={styles.headerActions}>
            {isFeatureVisible('playAloud') ? (
              <Pressable
                style={styles.headerAction}
                hitSlop={8}
                onPress={() => {
                  if (isSpeaking) {
                    speechAlertAllowedRef.current = false;
                    void stopCompanionSpeech();
                    setIsSpeaking(false);
                    setSpeakingMessageId(null);
                    return;
                  }
                  void toggleAutoSpeak();
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  isSpeaking
                    ? 'Stop speaking'
                    : autoSpeakOn
                      ? 'Voxa speaks replies on. Tap to turn off.'
                      : 'Voxa speaks replies off. Tap to turn on.'
                }>
                <Ionicons
                  name={isSpeaking ? 'stop-circle' : autoSpeakOn ? 'volume-high' : 'volume-mute'}
                  size={18}
                  color={autoSpeakOn || isSpeaking ? colors.primarySoft : colors.textMuted}
                />
              </Pressable>
            ) : null}
            <Pressable
              style={styles.headerAction}
              hitSlop={8}
              onPress={() => setMemoryPanelOpen(true)}
              accessibilityLabel="Memory and context">
              <Ionicons name="layers-outline" size={17} color={colors.textMuted} />
            </Pressable>
            <Pressable
              style={styles.headerAction}
              hitSlop={8}
              onPress={() => setHeaderMenuOpen(true)}
              accessibilityLabel="More options">
              <Ionicons name="ellipsis-horizontal" size={17} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>

        {messages.length === 0 && livingCompanion?.thinkingAbout ? (
          <View style={styles.contextThought}>
            <VoxaText variant="caption" color="textSecondary" numberOfLines={1}>
              {livingCompanion.thinkingAbout}
            </VoxaText>
          </View>
        ) : null}

        {error ? (
          <Pressable
            style={styles.inlineError}
            onPress={() => {
              const canRetry = talkErrorRetryCanSucceed(sendErrorCodeRef.current);
              setError(null);
              sendErrorCodeRef.current = canRetry ? sendErrorCodeRef.current : null;
              if (!canRetry) {
                sendErrorCodeRef.current = null;
                return;
              }
              const failed = [...messagesRef.current].reverse().find((item) => item.role === 'user' && item.status === 'failed');
              if (failed) void handleRetrySend(failed);
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry failed send">
            <VoxaText variant="caption" color="textSecondary">
              {error}
            </VoxaText>
            <VoxaText variant="caption" color="primarySoft">
              {talkErrorRetryCanSucceed(sendErrorCodeRef.current) &&
              messages.some((item) => item.status === 'failed')
                ? 'Tap to retry'
                : 'Tap to dismiss'}
            </VoxaText>
          </Pressable>
        ) : null}

        {__DEV__ && !isTyping && contextCards.length > 0 ? (
          <View style={styles.contextStrip}>
            <ContextCardsRow
              cards={contextCards}
              thinkingAbout={livingCompanion?.thinkingAbout}
              onSelect={handleContextCard}
            />
          </View>
        ) : null}

        {__DEV__ && !isTyping && contextChips.length > 0 ? (
          <View style={styles.contextStrip}>
            <ChatContextChips
              chips={contextChips}
              onSelect={(chip) => {
                if (chip.kind === 'goal') void sendMessage([], `Let's talk about my goal: ${chip.label}`);
                else if (chip.kind === 'memory') void sendMessage([], `Tell me more about "${chip.label}"`);
                else if (chip.kind === 'routine') void sendMessage([], chip.label);
                else void sendMessage([], chip.label);
              }}
            />
          </View>
        ) : null}

        {canvas && !isTyping ? (
          <ConversationCanvasCard
            canvas={canvas}
            expanded={canvasExpanded}
            onToggle={() => setCanvasExpanded((v) => !v)}
          />
        ) : null}

        {actionFeedback ? (
          <View style={styles.inlineError}>
            <VoxaText variant="caption" color="primarySoft">
              {actionFeedback}
            </VoxaText>
          </View>
        ) : null}

        <View style={styles.listWrap}>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={keyExtractor}
            extraData={speakingMessageId ?? ''}
            contentContainerStyle={styles.messages}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            renderItem={renderMessage}
            removeClippedSubviews
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={50}
            windowSize={7}
            onContentSizeChange={() => {
              if (pinTalkOnNextLayoutRef.current) {
                pinTalkOnNextLayoutRef.current = false;
                pinTalkToLatest('load');
              }
            }}
            onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              const metrics = {
                contentOffsetY: contentOffset.y,
                contentHeight: contentSize.height,
                layoutHeight: layoutMeasurement.height,
              };
              const nearBottom = isTalkListNearBottom(metrics);
              userReadingHistoryRef.current = !nearBottom;
              const nextVisible = nextTalkJumpToLatestVisible({
                currentlyVisible: showJumpToLatestRef.current,
                ...metrics,
              });
              if (nextVisible !== showJumpToLatestRef.current) {
                showJumpToLatestRef.current = nextVisible;
                setShowJumpToLatest(nextVisible);
              }
            }}
            scrollEventThrottle={16}
            onScrollToIndexFailed={(info) => {
              setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, animated: true }), 200);
            }}
            ListEmptyComponent={
              !isTyping ? (
                <ChatEmptyState
                  voxaName={voxaName}
                  tint={voxaTint}
                  greeting={chatEmptyGreeting}
                  emotionalLine={chatEmptyLine}
                  orbMood={orbMood}
                  orbState={orbState}
                  starters={messages.length === 0 ? capSuggestions(quickPrompts, 3) : []}
                  onSelectStarter={(text) => void sendMessage([], text)}
                />
              ) : null
            }
            ListFooterComponent={
              isTyping ? (
                <TypingIndicator
                  voxaName={voxaName}
                  tint={voxaTint}
                  streamingText={streamingText}
                  thinkingLabel={THINKING_STATUS_LABELS[thinkingStage]}
                />
              ) : null
            }
          />
          <TalkJumpToLatestButton visible={showJumpToLatest && messages.length > 0} onPress={jumpToLatest} />
        </View>

        {!isTyping &&
        !suggestionsDismissed &&
        !input.trim() &&
        suggestions.length > 0 &&
        messages.length > 0 ? (
          <View style={styles.suggestions}>
            <SuggestedReplies
              suggestions={capSuggestions(suggestions)}
              onSelect={(text) => void sendMessage([], text)}
              onDismiss={() => setSuggestionsDismissed(true)}
            />
          </View>
        ) : null}

        {focusSession ? (
          <FocusModeBar
            session={focusSession}
            progressPercent={focusProgress}
            onEnd={() => {
              if (!profile) return;
              void getFocusModeService(services.storage).complete(profile.id);
              setFocusSession(null);
            }}
          />
        ) : null}

        <ChatInputBar
          key={profile?.id ?? 'anon'}
          value={input}
          onChangeText={(text) => {
            setInput(text);
            if (text.trim()) {
              setSuggestions([]);
              setSuggestionsDismissed(true);
            }
          }}
          onSend={(attachments) => sendMessage(attachments)}
          disabled={false}
          voxaName={voxaName}
          editing={Boolean(composerEdit)}
          onCancelEdit={handleCancelEdit}
          onVoiceNoteLimit={(message) => {
            setLimitMessage(message);
            setLimitModalVisible(true);
          }}
        />
      </KeyboardAvoidingView>

      <ChatToolsSheet
        visible={toolsSheetOpen}
        onClose={() => setToolsSheetOpen(false)}
        onAction={handleComposerAction}
      />

      <MemoryPanel
        visible={memoryPanelOpen}
        items={memoryPanelItems}
        onClose={() => setMemoryPanelOpen(false)}
        onToggleInclude={() => undefined}
      />

      <Modal visible={headerMenuOpen} transparent animationType="fade">
        <Pressable style={styles.modalBackdrop} onPress={() => setHeaderMenuOpen(false)}>
          <View style={[styles.menuSheet, { top: layout.tabBarHeight + 56 }]}>
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setHeaderMenuOpen(false);
                setToolsSheetOpen(true);
              }}>
              <Ionicons name="sparkles-outline" size={18} color={colors.primarySoft} />
              <VoxaText variant="body">Tools</VoxaText>
            </Pressable>
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setHeaderMenuOpen(false);
                void startNewConversation();
              }}>
              <Ionicons name="add-circle-outline" size={18} color={colors.primarySoft} />
              <VoxaText variant="body">New conversation</VoxaText>
            </Pressable>
            <Pressable style={styles.menuRow} onPress={() => { setHeaderMenuOpen(false); setSearchOpen(true); }}>
              <Ionicons name="search-outline" size={18} color={colors.primarySoft} />
              <VoxaText variant="body">Search conversation</VoxaText>
            </Pressable>
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setHeaderMenuOpen(false);
                navigation.navigate('ConversationHistory');
              }}>
              <Ionicons name="time-outline" size={18} color={colors.primarySoft} />
              <VoxaText variant="body">History</VoxaText>
            </Pressable>
            {isFeatureVisible('musicRecognition') ? (
              <Pressable
                style={styles.menuRow}
                onPress={() => {
                  setHeaderMenuOpen(false);
                  navigation.navigate('Music');
                }}>
                <Ionicons name="musical-notes-outline" size={18} color={colors.primarySoft} />
                <VoxaText variant="body">Music</VoxaText>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={searchOpen} transparent animationType="fade">
        <Pressable style={styles.modalBackdrop} onPress={() => setSearchOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <VoxaText variant="subtitle">Search conversation</VoxaText>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search messages..."
              placeholderTextColor={colors.textMuted}
              style={styles.searchInput}
              autoFocus
            />
            <VoxaText variant="caption" color="textMuted">
              {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
            </VoxaText>
            {searchResults.slice(0, 8).map((item) => (
              <Pressable key={item.id} style={styles.searchRow} onPress={() => scrollToMessage(item.id)}>
                <VoxaText variant="caption" color="primarySoft">{item.role === 'user' ? 'You' : voxaName}</VoxaText>
                <VoxaText variant="body" numberOfLines={2}>{item.text || 'Attachment'}</VoxaText>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      <LimitReachedModal
        visible={limitModalVisible}
        message={
          limitMessage ||
          "You've used today's conversation allowance. You can continue using core Voxa features, or upgrade for more."
        }
        onUpgrade={() => {
          setLimitModalVisible(false);
          void (async () => {
            if (!profile) {
              navigateToPaywall(navigation, 'chat-limit');
              return;
            }
            const show = await services.entitlementAccess.shouldShowContextualPaywall(profile.id);
            if (!show) return;
            await services.entitlementAccess.markPaywallShown(profile.id, 'chat-limit');
            navigateToPaywall(navigation, 'chat-limit');
          })();
        }}
        onContinueFree={() => setLimitModalVisible(false)}
      />
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: { flex: 1, minWidth: 0, gap: 1 },
  headerTitle: { fontSize: 17, lineHeight: 22 },
  headerStatus: { fontSize: 12, lineHeight: 16 },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  headerAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineError: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.sm,
    gap: 2,
  },
  contextThought: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.xs,
    flexGrow: 0,
    flexShrink: 0,
  },
  contextStrip: {
    flexGrow: 0,
    flexShrink: 0,
  },
  listWrap: { flex: 1 },
  messages: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    flexGrow: 1,
  },
  suggestions: {
    width: '100%',
    alignSelf: 'stretch',
    minWidth: 0,
    paddingLeft: layout.screenPadding,
    paddingRight: spacing.sm,
    paddingBottom: spacing.xs,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
    padding: layout.screenPadding,
    paddingBottom: layout.tabBarHeight,
  },
  modalCard: {
    backgroundColor: colors.surfaceStrong,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  modalTitle: { marginBottom: spacing.sm },
  searchInput: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.md,
    color: colors.text,
    fontSize: 16,
    marginVertical: spacing.sm,
  },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  modeRowActive: { backgroundColor: 'rgba(45, 212, 191, 0.08)' },
  modeRowCopy: { flex: 1, gap: 2 },
  menuSheet: {
    position: 'absolute',
    right: layout.screenPadding,
    backgroundColor: colors.surfaceStrong,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.sm,
    minWidth: 220,
    gap: spacing.xs,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  searchRow: {
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    gap: 2,
  },
});
