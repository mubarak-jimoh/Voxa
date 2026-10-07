import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { BackButton } from '../components/ui/back-button';
import { GlassCard } from '../components/ui/glass-card';
import { ScreenShell } from '../components/ui/screen-shell';
import { VoxaText } from '../components/ui/voxa-text';
import { PremiumButton } from '../components/premium/premium-ui';
import { LoadingState } from '../components/ui/screen-state';
import { colors, layout, radius, spacing } from '../constants/theme';
import { useVoxa } from '../context/voxa-context';
import { RootStackParamList } from '../navigation/types';
import { getNotesService } from '../services/notes/notes-service';
import {
  isProNoteAction,
  listNoteAIActions,
  noteAIActionLabel,
  noteAIToolsDisclaimer,
  runNoteAIAction,
} from '../services/notes/notes-ai-service';
import { trackEvent } from '../services/analytics/analytics-service';
import { navigateToPaywall } from '../utils/paywall-navigation';
import {
  Note,
  NoteAIActionId,
  NoteAIActionResult,
  NoteChecklistItem,
  NoteFolder,
  NoteMemoryConsent,
  NoteType,
  NOTE_TYPE_LABELS,
} from '../types/notes';
import { createUuid } from '../types';
import { usePlanStatus } from '../hooks/use-plan-status';
import { hapticLight, hapticSelection, hapticWarning } from '../utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'NoteEditor'>;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const TYPES: NoteType[] = ['standard', 'checklist', 'journal', 'study', 'idea', 'meeting'];

export function NoteEditorScreen({ navigation, route }: Props) {
  const { noteId } = route.params;
  const { profile, services } = useVoxa();
  const { isPro } = usePlanStatus();
  const insets = useSafeAreaInsets();
  const notesService = useMemo(() => getNotesService(services.storage), [services.storage]);

  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [checklist, setChecklist] = useState<NoteChecklistItem[]>([]);
  const [type, setType] = useState<NoteType>('standard');
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [favourite, setFavourite] = useState(false);
  const [memoryConsent, setMemoryConsent] = useState<NoteMemoryConsent>('private');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPreview, setAiPreview] = useState<NoteAIActionResult | null>(null);

  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef({
    title,
    body,
    tagsText,
    checklist,
    type,
    pinned,
    archived,
    favourite,
    memoryConsent,
    folderId,
  });

  latestRef.current = {
    title,
    body,
    tagsText,
    checklist,
    type,
    pinned,
    archived,
    favourite,
    memoryConsent,
    folderId,
  };

  const persist = useCallback(async () => {
    if (!profile || !noteId) return;
    const current = latestRef.current;
    setSaveState('saving');
    try {
      const tags = current.tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await notesService.update(profile.id, noteId, {
        title: current.title,
        body: current.body,
        tags,
        checklist: current.checklist,
        type: current.type,
        pinned: current.pinned,
        archived: current.archived,
        favourite: current.favourite,
        memoryConsent: current.memoryConsent,
        folderId: current.folderId,
      });
      if (updated) {
        let next = updated;
        if (current.memoryConsent === 'remember' && !updated.linkedMemoryId) {
          const memory = await services.repositories.memories.createMemory({
            userId: profile.id,
            category: 'moments',
            title: `Note: ${updated.title.trim() || 'Untitled'}`,
            content: (updated.body || updated.title).slice(0, 500),
            source: 'manual',
            tags: ['from-note', updated.id],
            importance: 3,
          });
          next = (await notesService.update(profile.id, noteId, { linkedMemoryId: memory.id })) ?? updated;
        }
        if (current.memoryConsent === 'private' && updated.linkedMemoryId) {
          try {
            await services.repositories.memories.deleteMemory(updated.linkedMemoryId);
          } catch {
            // Memory may already be gone
          }
          next =
            (await notesService.update(profile.id, noteId, {
              linkedMemoryId: undefined,
            })) ?? updated;
        }
        setNote(next);
        dirtyRef.current = false;
        setSaveState('saved');
        trackEvent('note_edited', { type: next.type });
      } else {
        setSaveState('error');
      }
    } catch {
      setSaveState('error');
    }
  }, [profile, noteId, notesService, services.repositories.memories]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState('idle');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persist();
    }, 650);
  }, [persist]);

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    const loaded = await notesService.get(profile.id, noteId);
    if (!loaded) {
      setLoading(false);
      Alert.alert('Note missing', 'This note could not be found.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
      return;
    }
    setNote(loaded);
    setTitle(loaded.title);
    setBody(loaded.body);
    setTagsText(loaded.tags.join(', '));
    setChecklist(loaded.checklist);
    setType(loaded.type);
    setPinned(loaded.pinned);
    setArchived(loaded.archived);
    setFavourite(loaded.favourite);
    setMemoryConsent(loaded.memoryConsent);
    setFolderId(loaded.folderId);
    setFolders(await notesService.listFolders(profile.id));
    setLoading(false);
  }, [profile, noteId, notesService, navigation]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
      };
    }, [load, persist]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && dirtyRef.current) void persist();
    });
    return () => sub.remove();
  }, [persist]);

  const mark = (updater: () => void) => {
    updater();
    scheduleSave();
  };

  const goBack = useCallback(async () => {
    Keyboard.dismiss();
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (dirtyRef.current) {
      await persist();
      if (dirtyRef.current) return;
    }
    navigation.goBack();
  }, [navigation, persist]);

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void persist().then(() => {
        if (!dirtyRef.current) navigation.dispatch(e.data.action);
      });
    });
    return unsub;
  }, [navigation, persist]);

  const toggleChecklistItem = (id: string) => {
    void hapticSelection();
    mark(() =>
      setChecklist((items) =>
        items.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
      ),
    );
  };

  const addChecklistItem = () => {
    mark(() =>
      setChecklist((items) => [...items, { id: createUuid(), text: '', done: false }]),
    );
  };

  const runAi = async (actionId: NoteAIActionId) => {
    if (!note || !profile) return;
    if (isProNoteAction(actionId) && !isPro) {
      const show = await services.entitlementAccess.shouldShowContextualPaywall(profile.id);
      if (show) {
        await services.entitlementAccess.markPaywallShown(profile.id, 'note-ai');
        navigateToPaywall(navigation, 'note-ai');
      }
      return;
    }

    if (actionId === 'discuss') {
      await persist();
      const attached = `${title.trim() || 'Untitled'}\n\n${body}`.trim();
      navigation.navigate('MainTabs', {
        screen: 'Talk',
        params: {
          starterPrompt: `I'd like to discuss this note with you. Treat the following as attached context (do not claim you read private notes beyond this):\n\n${attached}`,
        },
      });
      trackEvent('note_ai_action_completed', { action: actionId });
      return;
    }

    setAiBusy(true);
    trackEvent('note_ai_action_started', { action: actionId });
    try {
      const result = await runNoteAIAction({
        note: { ...note, title, body, checklist, type },
        actionId,
        isPro,
      });
      setAiPreview(result);
      trackEvent('note_ai_action_completed', { action: actionId });
    } catch (err) {
      Alert.alert('Note tool', err instanceof Error ? err.message : 'Could not run action.');
    } finally {
      setAiBusy(false);
    }
  };

  const applyPreview = async (mode: 'replace' | 'insert' | 'new') => {
    if (!aiPreview || !profile) return;
    if (aiPreview.checklist?.length) {
      mark(() => {
        setType('checklist');
        setChecklist(aiPreview.checklist!);
        if (!body.trim()) setBody(aiPreview.previewText);
      });
    } else if (mode === 'replace') {
      mark(() => setBody(aiPreview.previewText));
    } else if (mode === 'insert') {
      mark(() => setBody((current) => `${current.trim()}\n\n${aiPreview.previewText}`.trim()));
    } else {
      const created = await notesService.create(profile.id, {
        title: `${title || 'Note'} — AI`,
        body: aiPreview.previewText,
        type: 'standard',
      });
      trackEvent('note_created', { type: created.type, source: 'ai' });
      setAiPreview(null);
      setAiOpen(false);
      navigation.replace('NoteEditor', { noteId: created.id });
      return;
    }
    setAiPreview(null);
    setAiOpen(false);
  };

  const confirmDelete = () => {
    setMenuOpen(false);
    Alert.alert('Delete note?', 'This removes the note from your library.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!profile || !note) return;
          await persist();
          if (note.linkedMemoryId) {
            try {
              await services.repositories.memories.deleteMemory(note.linkedMemoryId);
            } catch {
              // ignore
            }
          }
          await notesService.softDelete(profile.id, noteId);
          navigation.goBack();
        },
      },
    ]);
  };

  const editTags = () => {
    setMenuOpen(false);
    Alert.prompt('Tags', 'Comma-separated labels', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Save',
        onPress: (value?: string) => {
          if (value === undefined) return;
          mark(() => setTagsText(value));
        },
      },
    ]);
  };

  const pickNoteType = () => {
    setMenuOpen(false);
    Alert.alert('Note type', undefined, [
      ...TYPES.map((id) => ({
        text: NOTE_TYPE_LABELS[id],
        onPress: () => mark(() => setType(id)),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const pickMemoryConsent = () => {
    setMenuOpen(false);
    Alert.alert(
      'Memory',
      'Choose how Voxa may use this note.',
      [
        {
          text: 'Keep private',
          onPress: () => mark(() => setMemoryConsent('private')),
        },
        {
          text: 'Ask Voxa to remember',
          onPress: () => mark(() => setMemoryConsent('remember')),
        },
        {
          text: 'Use in conversations',
          onPress: () => mark(() => setMemoryConsent('use_in_conversations')),
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const pickFolder = () => {
    setMenuOpen(false);
    Alert.alert('Move to folder', undefined, [
      {
        text: 'All notes (no folder)',
        onPress: () => mark(() => setFolderId(null)),
      },
      ...folders.map((folder) => ({
        text: folder.name,
        onPress: () => mark(() => setFolderId(folder.id)),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  if (loading || !note) {
    return (
      <ScreenShell>
        <BackButton onPress={() => navigation.goBack()} />
        <LoadingState label="Opening note..." />
      </ScreenShell>
    );
  }

  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved'
        : saveState === 'error'
          ? 'Save failed'
          : '';

  const memoryLabel =
    memoryConsent === 'private'
      ? 'Private'
      : memoryConsent === 'remember'
        ? 'Saved to memory'
        : 'Usable in chat';

  return (
    <ScreenShell padded={false}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}>
        <View style={[styles.toolbar, { paddingTop: insets.top + spacing.sm }]}>
          <BackButton onPress={() => void goBack()} compact />
          <VoxaText variant="caption" color="textMuted" style={styles.saveHint} numberOfLines={1}>
            {saveLabel}
          </VoxaText>
          <Pressable
            onPress={() => {
              void hapticLight();
              setMenuOpen(true);
            }}
            hitSlop={12}
            style={styles.menuBtn}
            accessibilityRole="button"
            accessibilityLabel="Note options">
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.editor}
          contentContainerStyle={styles.editorContent}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled">
          <TextInput
            value={title}
            onChangeText={(value) => mark(() => setTitle(value))}
            placeholder="Title"
            placeholderTextColor={colors.textMuted}
            style={styles.titleInput}
            accessibilityLabel="Note title"
            returnKeyType="next"
          />

          {type === 'checklist' ? (
            <View style={styles.checklistContent}>
              {checklist.map((item) => (
                <View key={item.id} style={styles.checkRow}>
                  <Pressable
                    onPress={() => toggleChecklistItem(item.id)}
                    hitSlop={8}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: item.done }}>
                    <Ionicons
                      name={item.done ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={colors.primarySoft}
                    />
                  </Pressable>
                  <TextInput
                    value={item.text}
                    onChangeText={(text) =>
                      mark(() =>
                        setChecklist((items) =>
                          items.map((row) => (row.id === item.id ? { ...row, text } : row)),
                        ),
                      )
                    }
                    placeholder="Item"
                    placeholderTextColor={colors.textMuted}
                    style={[styles.checkInput, item.done && styles.checkDone]}
                  />
                </View>
              ))}
              <Pressable onPress={addChecklistItem} style={styles.addItem} accessibilityRole="button">
                <Ionicons name="add" size={18} color={colors.primarySoft} />
                <VoxaText variant="body" color="primarySoft">
                  Add item
                </VoxaText>
              </Pressable>
            </View>
          ) : (
            <TextInput
              value={body}
              onChangeText={(value) => mark(() => setBody(value))}
              placeholder="Start writing…"
              placeholderTextColor={colors.textMuted}
              style={styles.bodyInput}
              multiline
              textAlignVertical="top"
              accessibilityLabel="Note body"
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={menuOpen} animationType="slide" transparent onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)}>
          <Pressable style={[styles.modalSheet, { paddingBottom: insets.bottom + spacing.md }]}>
            <VoxaText variant="subtitle">Note options</VoxaText>
            <VoxaText variant="caption" color="textMuted">
              {NOTE_TYPE_LABELS[type]} · {memoryLabel}
              {folders.find((folder) => folder.id === folderId)
                ? ` · ${folders.find((folder) => folder.id === folderId)?.name}`
                : ''}
              {tagsText.trim() ? ` · ${tagsText.split(',').filter(Boolean).length} tags` : ''}
            </VoxaText>
            {(
              [
                {
                  label: pinned ? 'Unpin note' : 'Pin note',
                  onPress: () => {
                    setMenuOpen(false);
                    mark(() => setPinned((v) => !v));
                  },
                },
                {
                  label: favourite ? 'Remove favourite' : 'Favourite',
                  onPress: () => {
                    setMenuOpen(false);
                    mark(() => setFavourite((v) => !v));
                  },
                },
                { label: 'Change note type', onPress: pickNoteType },
                { label: 'Move to folder', onPress: pickFolder },
                { label: 'Edit tags', onPress: editTags },
                {
                  label: archived ? 'Unarchive' : 'Archive',
                  onPress: () => {
                    setMenuOpen(false);
                    mark(() => setArchived((v) => !v));
                  },
                },
                { label: 'Memory & privacy', onPress: pickMemoryConsent },
                {
                  label: 'Duplicate',
                  onPress: async () => {
                    setMenuOpen(false);
                    if (!profile) return;
                    await persist();
                    const copy = await notesService.duplicate(profile.id, noteId);
                    if (copy) navigation.replace('NoteEditor', { noteId: copy.id });
                  },
                },
                {
                  label: 'Quick tools',
                  onPress: () => {
                    setMenuOpen(false);
                    setAiOpen(true);
                  },
                },
                {
                  label: 'Delete note',
                  destructive: true,
                  onPress: () => {
                    void hapticWarning();
                    confirmDelete();
                  },
                },
              ] as Array<{ label: string; onPress: () => void; destructive?: boolean }>
            ).map((action) => (
              <Pressable
                key={action.label}
                style={styles.menuRow}
                onPress={action.onPress}
                accessibilityRole="button">
                <VoxaText variant="body" color={action.destructive ? 'danger' : 'text'}>
                  {action.label}
                </VoxaText>
              </Pressable>
            ))}
            <PremiumButton label="Close" variant="ghost" onPress={() => setMenuOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={aiOpen} animationType="slide" transparent onRequestClose={() => setAiOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + spacing.md }]}>
            <VoxaText variant="subtitle">Quick note tools</VoxaText>
            <VoxaText variant="caption" color="textMuted">
              {noteAIToolsDisclaimer()}
            </VoxaText>
            <ScrollView style={styles.modalScroll}>
              {listNoteAIActions(true).map((actionId) => {
                const locked = isProNoteAction(actionId) && !isPro;
                return (
                  <Pressable
                    key={actionId}
                    style={styles.menuRow}
                    disabled={aiBusy}
                    onPress={() => void runAi(actionId)}>
                    <VoxaText variant="body">
                      {noteAIActionLabel(actionId)}
                      {locked ? ' · Pro' : ''}
                    </VoxaText>
                  </Pressable>
                );
              })}
            </ScrollView>
            {aiPreview ? (
              <GlassCard style={styles.previewCard}>
                <VoxaText variant="caption" color="primarySoft">
                  Preview{aiPreview.isEstimate ? ' · on-device' : ''}
                </VoxaText>
                <VoxaText variant="body">{aiPreview.previewText}</VoxaText>
                <View style={styles.previewActions}>
                  <PremiumButton label="Replace" onPress={() => void applyPreview('replace')} />
                  <PremiumButton label="Insert" variant="ghost" onPress={() => void applyPreview('insert')} />
                  <PremiumButton label="New note" variant="ghost" onPress={() => void applyPreview('new')} />
                  <PremiumButton
                    label="Share"
                    variant="ghost"
                    onPress={() => void Share.share({ message: aiPreview.previewText })}
                  />
                </View>
              </GlassCard>
            ) : null}
            <PremiumButton
              label="Close"
              variant="ghost"
              onPress={() => {
                setAiOpen(false);
                setAiPreview(null);
              }}
            />
          </View>
        </View>
      </Modal>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  saveHint: { flex: 1, textAlign: 'center' },
  menuBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editor: {
    flex: 1,
  },
  editorContent: {
    flexGrow: 1,
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  titleInput: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: -0.5,
    lineHeight: 34,
    minHeight: 44,
  },
  bodyInput: {
    flex: 1,
    color: colors.text,
    fontSize: 17,
    lineHeight: 28,
    paddingVertical: spacing.xs,
    minHeight: 200,
  },
  checklistScroll: { flex: 1 },
  checklistContent: { gap: spacing.sm, paddingBottom: spacing.xl },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkInput: { flex: 1, color: colors.text, fontSize: 17, minHeight: 44, lineHeight: 24 },
  checkDone: { color: colors.textMuted, textDecorationLine: 'line-through' },
  addItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    maxHeight: '88%',
  },
  modalScroll: { maxHeight: 280 },
  menuRow: {
    paddingVertical: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  previewCard: { gap: spacing.sm },
  previewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
