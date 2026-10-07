/**
 * Focused unit checks for Notes / Voice / Entitlements pure logic.
 * Run: npm test
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_OPTIONS,
  assertVoiceCatalogueIntegrity,
  getVoiceOption,
  listVoiceOptions,
} from '../src/constants/voice-options';
import { NotesService, resetNotesServiceForTests } from '../src/services/notes/notes-service';
import {
  isProNoteAction,
  listNoteAIActions,
  noteAIToolsDisclaimer,
  runNoteAIAction,
} from '../src/services/notes/notes-ai-service';
import { formatNotesForPrompt } from '../src/services/notes/notes-context-service';
import type { Note } from '../src/types/notes';
import type { IStorageService } from '../src/services/contracts';

class MemoryStorage implements IStorageService {
  private data = new Map<string, unknown>();
  async getItem<T>(key: string): Promise<T | null> {
    return (this.data.get(key) as T) ?? null;
  }
  async setItem<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.data.delete(key);
  }
  async multiRemove(keys: string[]): Promise<void> {
    keys.forEach((key) => this.data.delete(key));
  }
}

test('voice catalogue integrity', () => {
  const errors = assertVoiceCatalogueIntegrity();
  assert.deepEqual(errors, []);
  assert.equal(listVoiceOptions(false).length, 4);
  assert.ok(listVoiceOptions(true).length >= 8);
  assert.equal(getVoiceOption('nova').openAiVoiceId, 'shimmer');
  assert.ok(!VOICE_OPTIONS.some((v) => /british|american|australian accent/i.test(v.toneNote)));
});

test('notes are isolated by userId', async () => {
  resetNotesServiceForTests();
  const storage = new MemoryStorage();
  const service = new NotesService(storage);

  const a = await service.create('user-a', { title: 'A private', body: 'secret-a' });
  await service.create('user-b', { title: 'B private', body: 'secret-b' });

  const listA = await service.list('user-a');
  const listB = await service.list('user-b');
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);
  assert.equal(listA[0]?.id, a.id);
  assert.equal(listA[0]?.body, 'secret-a');
  assert.equal(listB[0]?.body, 'secret-b');
});

test('soft delete retains sibling notes and hides deleted', async () => {
  resetNotesServiceForTests();
  const storage = new MemoryStorage();
  const service = new NotesService(storage);

  const first = await service.create('u1', { title: 'Keep' });
  const second = await service.create('u1', { title: 'Remove' });
  await service.softDelete('u1', second.id);

  const active = await service.list('u1');
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, first.id);

  await service.create('u1', { title: 'Third' });
  const after = await service.list('u1');
  assert.equal(after.length, 2);
});

test('notes folders filter All vs folder and persist assignment', async () => {
  resetNotesServiceForTests();
  const storage = new MemoryStorage();
  const service = new NotesService(storage);
  const folder = await service.createFolder('u1', 'Python');
  const inFolder = await service.create('u1', { title: 'Revise', folderId: folder.id });
  const unfiled = await service.create('u1', { title: 'Inbox', folderId: null });

  const all = await service.list('u1');
  assert.equal(all.length, 2);
  const python = await service.list('u1', { folderId: folder.id });
  assert.equal(python.length, 1);
  assert.equal(python[0]?.id, inFolder.id);
  const moved = await service.update('u1', unfiled.id, { folderId: folder.id });
  assert.equal(moved?.folderId, folder.id);
  const pythonAfter = await service.list('u1', { folderId: folder.id });
  assert.equal(pythonAfter.length, 2);
  const otherUser = await service.list('u2', { folderId: folder.id });
  assert.equal(otherUser.length, 0);
});

test('update latest write wins', async () => {
  resetNotesServiceForTests();
  const storage = new MemoryStorage();
  const service = new NotesService(storage);
  const note = await service.create('u1', { title: 'Draft', body: 'v1' });
  await service.update('u1', note.id, { body: 'v2' });
  const loaded = await service.get('u1', note.id);
  assert.equal(loaded?.body, 'v2');
});

test('free vs pro note tools', () => {
  const prev = process.env.EXPO_PUBLIC_FREE_LAUNCH_MODE;
  process.env.EXPO_PUBLIC_FREE_LAUNCH_MODE = 'false';
  try {
    const free = listNoteAIActions(false);
    const pro = listNoteAIActions(true);
    assert.ok(free.includes('summarise'));
    assert.ok(free.includes('discuss'));
    assert.ok(!free.includes('flashcards'));
    assert.ok(pro.includes('flashcards'));
    assert.equal(isProNoteAction('flashcards'), true);
    assert.equal(isProNoteAction('summarise'), false);
    assert.match(noteAIToolsDisclaimer(), /on-device/i);
  } finally {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_FREE_LAUNCH_MODE;
    else process.env.EXPO_PUBLIC_FREE_LAUNCH_MODE = prev;
  }
});

test('note tool preview never mutates input note', async () => {
  const note: Note = {
    id: 'n1',
    userId: 'u1',
    title: 'Plan',
    body: 'Line one\nLine two',
    type: 'standard',
    checklist: [],
    folderId: null,
    tags: [],
    pinned: false,
    archived: false,
    favourite: false,
    memoryConsent: 'private',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const original = JSON.stringify(note);
  const result = await runNoteAIAction({ note, actionId: 'summarise', isPro: false });
  assert.ok(result.previewText.length > 0);
  assert.equal(JSON.stringify(note), original);
});

test('private notes are excluded from conversation prompt helper', () => {
  const notes: Note[] = [
    {
      id: '1',
      userId: 'u',
      title: 'Shared',
      body: 'ok',
      type: 'standard',
      checklist: [],
      folderId: null,
      tags: [],
      pinned: false,
      archived: false,
      favourite: false,
      memoryConsent: 'use_in_conversations',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: '2',
      userId: 'u',
      title: 'Secret',
      body: 'private-body',
      type: 'standard',
      checklist: [],
      folderId: null,
      tags: [],
      pinned: false,
      archived: false,
      favourite: false,
      memoryConsent: 'private',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
  ];
  const prompt = formatNotesForPrompt(
    notes.filter((n) => n.memoryConsent === 'use_in_conversations'),
  );
  assert.match(prompt, /Shared/);
  assert.doesNotMatch(prompt, /Secret|private-body/);
});
