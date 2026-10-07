import { getNotesService } from './notes-service';
import { IStorageService } from '../contracts';
import { EntityId } from '../../types';
import { Note } from '../../types/notes';

/** Notes explicitly allowed for future conversation context (not private by default). */
export async function listNotesForConversationContext(
  storage: IStorageService,
  userId: EntityId,
  limit = 3,
): Promise<Note[]> {
  const notes = await getNotesService(storage).list(userId, {});
  return notes
    .filter((n) => n.memoryConsent === 'use_in_conversations')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export function formatNotesForPrompt(notes: Note[]): string {
  if (!notes.length) return '';
  return [
    '## User-permitted notes (explicitly shared for conversations)',
    ...notes.map((n) => {
      const title = (n.title ?? '').trim() || 'Untitled';
      const body = String(n.body ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
      return `- ${title}: ${body}`;
    }),
    'Do not claim you read other private notes.',
  ].join('\n');
}
