import { STORAGE_KEYS } from '../../constants/storage-keys';
import { createUuid, EntityId, nowIso } from '../../types';
import {
  Note,
  NoteChecklistItem,
  NoteFolder,
  NotesFilter,
  NoteSort,
  NoteType,
  NOTE_FOLDER_COLORS,
  NOTE_TEMPLATES,
} from '../../types/notes';
import { IStorageService } from '../contracts';

function sortNotes(notes: Note[], sort: NoteSort): Note[] {
  const copy = [...notes];
  copy.sort((a, b) => {
    switch (sort) {
      case 'title_asc':
        return a.title.localeCompare(b.title);
      case 'created_desc':
        return b.createdAt.localeCompare(a.createdAt);
      case 'updated_asc':
        return a.updatedAt.localeCompare(b.updatedAt);
      case 'updated_desc':
      default:
        return b.updatedAt.localeCompare(a.updatedAt);
    }
  });
  return copy;
}

/**
 * Local-first notes store keyed by userId.
 * Soft-deleted notes are retained until hard-purged so writes never wipe history by accident.
 * Guest → authenticated account note migration is NOT implemented; notes stay with their userId.
 */
export class NotesService {
  private readonly storage: IStorageService;

  constructor(storage: IStorageService) {
    this.storage = storage;
  }

  private async readAllNotes(userId: EntityId): Promise<Note[]> {
    const map = (await this.storage.getItem<Record<string, Note[]>>(STORAGE_KEYS.notes)) ?? {};
    return map[userId] ?? [];
  }

  private async readActiveNotes(userId: EntityId): Promise<Note[]> {
    return (await this.readAllNotes(userId)).filter((n) => !n.deletedAt);
  }

  private async writeNotes(userId: EntityId, notes: Note[]) {
    const map = (await this.storage.getItem<Record<string, Note[]>>(STORAGE_KEYS.notes)) ?? {};
    map[userId] = notes;
    await this.storage.setItem(STORAGE_KEYS.notes, map);
  }

  async listFolders(userId: EntityId): Promise<NoteFolder[]> {
    const map =
      (await this.storage.getItem<Record<string, NoteFolder[]>>(STORAGE_KEYS.noteFolders)) ?? {};
    return (map[userId] ?? []).map((folder, index) => ({
      ...folder,
      color: folder.color ?? NOTE_FOLDER_COLORS[index % NOTE_FOLDER_COLORS.length],
    }));
  }

  async ensureDefaultFolder(userId: EntityId): Promise<NoteFolder> {
    const folders = await this.listFolders(userId);
    if (folders[0]) return folders[0];
    const folder: NoteFolder = {
      id: createUuid(),
      userId,
      name: 'Personal',
      color: NOTE_FOLDER_COLORS[0],
      createdAt: nowIso(),
    };
    const map =
      (await this.storage.getItem<Record<string, NoteFolder[]>>(STORAGE_KEYS.noteFolders)) ?? {};
    map[userId] = [folder];
    await this.storage.setItem(STORAGE_KEYS.noteFolders, map);
    return folder;
  }

  async createFolder(userId: EntityId, name: string): Promise<NoteFolder> {
    const existing = await this.listFolders(userId);
    const folder: NoteFolder = {
      id: createUuid(),
      userId,
      name: name.trim() || 'Folder',
      color: NOTE_FOLDER_COLORS[existing.length % NOTE_FOLDER_COLORS.length],
      createdAt: nowIso(),
    };
    const map =
      (await this.storage.getItem<Record<string, NoteFolder[]>>(STORAGE_KEYS.noteFolders)) ?? {};
    map[userId] = [...(map[userId] ?? []), folder];
    await this.storage.setItem(STORAGE_KEYS.noteFolders, map);
    return folder;
  }

  async list(userId: EntityId, filter: NotesFilter = {}, sort: NoteSort = 'updated_desc') {
    let notes = await this.readActiveNotes(userId);
    if (!filter.includeArchived) notes = notes.filter((n) => !n.archived);
    if (filter.pinnedOnly) notes = notes.filter((n) => n.pinned);
    if (filter.favouritesOnly) notes = notes.filter((n) => n.favourite);
    if (filter.folderId) notes = notes.filter((n) => n.folderId === filter.folderId);
    if (filter.type) notes = notes.filter((n) => n.type === filter.type);
    if (filter.tag) {
      const tag = filter.tag.toLowerCase();
      notes = notes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag));
    }
    if (filter.query?.trim()) {
      const q = filter.query.trim().toLowerCase();
      notes = notes.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return sortNotes(notes, sort);
  }

  async get(userId: EntityId, noteId: string): Promise<Note | null> {
    const notes = await this.readActiveNotes(userId);
    return notes.find((n) => n.id === noteId) ?? null;
  }

  async create(
    userId: EntityId,
    input?: Partial<Pick<Note, 'title' | 'body' | 'type' | 'folderId' | 'tags'>>,
  ): Promise<Note> {
    await this.ensureDefaultFolder(userId);
    const type: NoteType = input?.type ?? 'standard';
    const template = NOTE_TEMPLATES[type];
    const stamped = nowIso();
    const note: Note = {
      id: createUuid(),
      userId,
      title: input?.title ?? template.title,
      body: input?.body ?? template.body,
      type,
      checklist: [],
      folderId: input?.folderId ?? null,
      tags: input?.tags ?? [],
      pinned: false,
      archived: false,
      favourite: false,
      memoryConsent: 'private',
      createdAt: stamped,
      updatedAt: stamped,
    };
    const all = await this.readAllNotes(userId);
    await this.writeNotes(userId, [note, ...all]);
    return note;
  }

  async update(userId: EntityId, noteId: string, patch: Partial<Note>): Promise<Note | null> {
    const all = await this.readAllNotes(userId);
    const idx = all.findIndex((n) => n.id === noteId && !n.deletedAt);
    if (idx < 0) return null;
    const next: Note = {
      ...all[idx]!,
      ...patch,
      id: all[idx]!.id,
      userId,
      updatedAt: nowIso(),
    };
    all[idx] = next;
    await this.writeNotes(userId, all);
    return next;
  }

  async duplicate(userId: EntityId, noteId: string): Promise<Note | null> {
    const original = await this.get(userId, noteId);
    if (!original) return null;
    const stamped = nowIso();
    const copy: Note = {
      ...original,
      id: createUuid(),
      title: original.title ? `${original.title} (copy)` : 'Untitled copy',
      pinned: false,
      archived: false,
      createdAt: stamped,
      updatedAt: stamped,
      deletedAt: undefined,
    };
    const all = await this.readAllNotes(userId);
    await this.writeNotes(userId, [copy, ...all]);
    return copy;
  }

  async softDelete(userId: EntityId, noteId: string): Promise<void> {
    const all = await this.readAllNotes(userId);
    const idx = all.findIndex((n) => n.id === noteId && !n.deletedAt);
    if (idx < 0) return;
    all[idx] = {
      ...all[idx]!,
      deletedAt: nowIso(),
      archived: true,
      updatedAt: nowIso(),
    };
    await this.writeNotes(userId, all);
  }

  async restoreArchived(userId: EntityId, noteId: string): Promise<Note | null> {
    return this.update(userId, noteId, { archived: false });
  }

  async deleteAll(userId: EntityId): Promise<void> {
    await this.writeNotes(userId, []);
  }

  async exportAll(userId: EntityId): Promise<string> {
    const notes = await this.list(userId, { includeArchived: true });
    const folders = await this.listFolders(userId);
    return JSON.stringify({ exportedAt: nowIso(), folders, notes }, null, 2);
  }

  async setChecklist(userId: EntityId, noteId: string, checklist: NoteChecklistItem[]) {
    return this.update(userId, noteId, { checklist, type: 'checklist' });
  }
}

let notesInstance: NotesService | null = null;
let notesBoundStorage: IStorageService | null = null;

export function getNotesService(storage: IStorageService) {
  if (!notesInstance || notesBoundStorage !== storage) {
    notesInstance = new NotesService(storage);
    notesBoundStorage = storage;
  }
  return notesInstance;
}

/** Test helper — resets singleton between unit tests. */
export function resetNotesServiceForTests() {
  notesInstance = null;
  notesBoundStorage = null;
}
