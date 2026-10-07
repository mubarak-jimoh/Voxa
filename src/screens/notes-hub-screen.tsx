import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { EmptyState, PremiumButton, ScreenHeader, SkeletonBlock, StaggerFade } from '../components/premium/premium-ui';
import { ScreenShell } from '../components/ui/screen-shell';
import { VoxaText } from '../components/ui/voxa-text';
import { colors, layout, radius, spacing } from '../constants/theme';
import { useVoxa } from '../context/voxa-context';
import { RootStackParamList } from '../navigation/types';
import { getNotesService } from '../services/notes/notes-service';
import { notesListEmptyCopy } from '../services/notes/notes-empty-copy';
import { trackEvent } from '../services/analytics/analytics-service';
import { Note, NoteFolder, NOTE_TYPE_LABELS } from '../types/notes';
import { isFeatureVisible } from '../config/feature-status';
import { hapticLight, hapticMedium, hapticSelection, hapticWarning } from '../utils/haptics';

type Props = NativeStackScreenProps<RootStackParamList, 'NotesHub'>;

const TYPE_ACCENT: Record<string, string> = {
  standard: colors.primarySoft,
  checklist: colors.accentSky,
  journal: colors.accentWarm,
  study: colors.blue,
  idea: colors.accentGold,
  meeting: colors.safe,
};

function NoteRow({
  note,
  onPress,
  onLongPress,
}: {
  note: Note;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const preview =
    note.type === 'checklist' && note.checklist.length
      ? `${note.checklist.filter((c) => c.done).length}/${note.checklist.length} done`
      : note.body.replace(/\s+/g, ' ').trim().slice(0, 90) || 'No content yet';
  const accent = TYPE_ACCENT[note.type] ?? colors.primarySoft;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={280}
      style={styles.row}
      accessibilityRole="button"
      accessibilityHint="Long press for pin, duplicate, share or delete">
      <View style={[styles.typeDot, { backgroundColor: accent }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          {note.pinned ? <Ionicons name="pin" size={14} color={colors.primarySoft} /> : null}
          {note.favourite ? <Ionicons name="heart" size={13} color={colors.accentWarm} /> : null}
          <VoxaText variant="body" style={styles.rowTitle} numberOfLines={1}>
            {note.title.trim() || 'Untitled'}
          </VoxaText>
        </View>
        <VoxaText variant="caption" color="textMuted" numberOfLines={2}>
          {preview}
        </VoxaText>
        <VoxaText variant="caption" color="textMuted" numberOfLines={1}>
          {NOTE_TYPE_LABELS[note.type]}
          {note.pinned || note.favourite ? ' · ' : ''}
          {note.pinned ? 'Pinned' : ''}
          {note.pinned && note.favourite ? ', ' : ''}
          {note.favourite ? 'Favourite' : ''}
        </VoxaText>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
    </Pressable>
  );
}

export function NotesHubScreen({ navigation }: Props) {
  const { profile, services } = useVoxa();
  const notesService = useMemo(() => getNotesService(services.storage), [services.storage]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setFolderId(null);
    setFavouritesOnly(false);
    setShowArchived(false);
    setQuery('');
    setDebouncedQuery('');
    setNotes([]);
    setFolders([]);
  }, [profile?.id]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const load = useCallback(async () => {
    if (!profile || !isFeatureVisible('notes')) return;
    setError(null);
    try {
      const [list, folderList] = await Promise.all([
        notesService.list(profile.id, {
          query: debouncedQuery,
          includeArchived: showArchived,
          folderId: folderId ?? undefined,
          favouritesOnly: favouritesOnly || undefined,
        }),
        notesService.listFolders(profile.id),
      ]);
      setFolders(folderList);
      setNotes(showArchived ? list.filter((n) => n.archived) : list.filter((n) => !n.archived));
    } catch {
      setError('Could not load notes. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [profile, notesService, debouncedQuery, showArchived, folderId, favouritesOnly]);

  const createFolder = () => {
    if (!profile) return;
    Alert.prompt('New folder', 'Name this collection', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Create',
        onPress: (name?: string) => {
          if (!name?.trim()) return;
          void notesService.createFolder(profile.id, name.trim()).then((folder) => {
            void hapticLight();
            setFolderId(folder.id);
            void load();
          });
        },
      },
    ]);
  };

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const createNote = async () => {
    if (!profile) return;
    void hapticMedium();
    const note = await notesService.create(profile.id, {
      folderId: folderId ?? null,
    });
    trackEvent('note_created', { type: note.type });
    navigation.navigate('NoteEditor', { noteId: note.id });
  };

  const openActions = (note: Note) => {
    if (!profile) return;
    void hapticSelection();
    Alert.alert(note.title.trim() || 'Untitled', undefined, [
      {
        text: note.pinned ? 'Unpin' : 'Pin',
        onPress: async () => {
          void hapticLight();
          await notesService.update(profile.id, note.id, { pinned: !note.pinned });
          void load();
        },
      },
      {
        text: 'Duplicate',
        onPress: async () => {
          void hapticLight();
          const copy = await notesService.duplicate(profile.id, note.id);
          if (copy) navigation.navigate('NoteEditor', { noteId: copy.id });
        },
      },
      {
        text: 'Share',
        onPress: () => {
          void Share.share({
            message: `${note.title.trim() || 'Untitled'}\n\n${note.body}`.trim(),
          });
        },
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void hapticWarning();
          Alert.alert('Delete note?', 'This removes the note from your library.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: async () => {
                await notesService.softDelete(profile.id, note.id);
                void load();
              },
            },
          ]);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  if (!isFeatureVisible('notes')) {
    return (
      <ScreenShell>
        <View style={styles.pad}>
          <EmptyState
            icon="document-text-outline"
            title="Notes unavailable"
            message="This feature is not enabled in this build."
            actionLabel="Back"
            onAction={() => navigation.goBack()}
          />
        </View>
      </ScreenShell>
    );
  }

  const selectedFolder = folders.find((folder) => folder.id === folderId) ?? null;
  const emptyCopy = notesListEmptyCopy({
    query: debouncedQuery,
    folderName: selectedFolder?.name ?? null,
    showArchived,
    favouritesOnly,
  });
  const pinned = notes.filter((n) => n.pinned);
  const recent = notes.filter((n) => !n.pinned);
  const sections: Array<{ title: string; data: Note[] }> = [];
  if (pinned.length) sections.push({ title: 'Pinned', data: pinned });
  if (recent.length) sections.push({ title: showArchived ? 'Archived' : 'Recent', data: recent });

  return (
    <ScreenShell>
      <View style={styles.pad}>
        <ScreenHeader
          onBack={() => {
            Keyboard.dismiss();
            navigation.goBack();
          }}
          title="Notes"
          subtitle="Private by default."
          right={<PremiumButton label="New" onPress={() => void createNote()} />}
        />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search notes"
          placeholderTextColor={colors.textMuted}
          style={styles.search}
          accessibilityLabel="Search notes"
          returnKeyType="search"
          clearButtonMode="while-editing"
          onSubmitEditing={() => Keyboard.dismiss()}
        />
        <View style={styles.folderRow}>
          <Pressable
            onPress={() => {
              void hapticSelection();
              setFolderId(null);
            }}
            style={[styles.folderChip, folderId === null && styles.folderChipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: folderId === null }}>
            <VoxaText variant="caption" color={folderId === null ? 'primarySoft' : 'textMuted'}>
              All
            </VoxaText>
          </Pressable>
          {folders.map((folder) => (
            <Pressable
              key={folder.id}
              onPress={() => {
                void hapticSelection();
                setFolderId(folder.id);
              }}
              style={[styles.folderChip, folderId === folder.id && styles.folderChipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: folderId === folder.id }}>
              <View style={[styles.folderDot, { backgroundColor: folder.color }]} />
              <VoxaText variant="caption" color={folderId === folder.id ? 'primarySoft' : 'textMuted'}>
                {folder.name}
              </VoxaText>
            </Pressable>
          ))}
          <Pressable
            onPress={createFolder}
            style={styles.folderChip}
            accessibilityRole="button"
            accessibilityLabel="Create folder">
            <Ionicons name="add" size={14} color={colors.primarySoft} />
            <VoxaText variant="caption" color="primarySoft">
              Folder
            </VoxaText>
          </Pressable>
        </View>
        <View style={styles.toggleRow}>
          <Pressable
            onPress={() => {
              void hapticSelection();
              setFavouritesOnly((v) => !v);
            }}
            style={styles.archiveToggle}
            accessibilityRole="button"
            accessibilityState={{ selected: favouritesOnly }}>
            <VoxaText variant="caption" color={favouritesOnly ? 'primarySoft' : 'textMuted'}>
              {favouritesOnly ? 'Favourites only' : 'All notes'}
            </VoxaText>
          </Pressable>
          <Pressable
            onPress={() => {
              void hapticSelection();
              setShowArchived((v) => !v);
            }}
            style={styles.archiveToggle}
            accessibilityRole="button">
            <VoxaText variant="caption" color="primarySoft">
              {showArchived ? 'Show active' : 'Show archived'}
            </VoxaText>
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={[styles.pad, { gap: spacing.md }]}>
          <SkeletonBlock height={88} />
          <SkeletonBlock height={88} />
          <SkeletonBlock height={88} />
        </View>
      ) : error ? (
        <View style={styles.pad}>
          <EmptyState
            icon="alert-circle-outline"
            title="Something went wrong"
            message={error}
            actionLabel="Retry"
            onAction={() => void load()}
          />
        </View>
      ) : notes.length === 0 ? (
        <View style={styles.pad}>
          <EmptyState
            icon="create-outline"
            title={emptyCopy.title}
            message={emptyCopy.message}
            actionLabel={showArchived ? undefined : 'Create note'}
            onAction={showArchived ? undefined : () => void createNote()}
          />
        </View>
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(item) => item.title}
          contentContainerStyle={styles.list}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item: section, index }) => (
            <StaggerFade index={index}>
              <View style={styles.section}>
                <VoxaText variant="label" color="textMuted" style={styles.sectionTitle}>
                  {section.title}
                </VoxaText>
                {section.data.map((note, noteIndex) => (
                  <View key={note.id}>
                    <NoteRow
                      note={note}
                      onPress={() => {
                        void hapticSelection();
                        navigation.navigate('NoteEditor', { noteId: note.id });
                      }}
                      onLongPress={() => openActions(note)}
                    />
                    {noteIndex < section.data.length - 1 ? <View style={styles.divider} /> : null}
                  </View>
                ))}
              </View>
            </StaggerFade>
          )}
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
        />
      )}
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  pad: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  search: {
    backgroundColor: colors.surfaceQuiet,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md12,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
  },
  archiveToggle: { minHeight: 44, justifyContent: 'center' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  folderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  folderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: layout.minTapTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceQuiet,
  },
  folderChipActive: { borderColor: colors.primarySoft },
  folderDot: { width: 8, height: 8, borderRadius: 4 },
  list: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.xxl,
    paddingTop: spacing.sm,
  },
  section: {
    backgroundColor: colors.surfaceQuiet,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md12,
    minHeight: 72,
  },
  typeDot: { width: 8, height: 8, borderRadius: 4 },
  rowBody: { flex: 1, gap: 4 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTitle: { flex: 1 },
  divider: { height: 1, backgroundColor: colors.borderSubtle, marginLeft: spacing.xxl },
});
