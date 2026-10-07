import { STORAGE_KEYS } from '../../constants/storage-keys';
import { createUuid, EntityId, nowIso } from '../../types';
import { FutureConversation } from '../../types/phase8-retention';
import { IStorageService } from '../contracts';

const CONTINUE_PATTERNS = [
  /\bcontinue tomorrow\b/i,
  /\bpick (this|it) up tomorrow\b/i,
  /\bwe(?:'ll| will) continue\b/i,
  /\btalk tomorrow\b/i,
  /\bfinish (this|it) tomorrow\b/i,
];

export function detectFutureConversation(text: string): { topic: string; resumeLine: string } | null {
  if (!CONTINUE_PATTERNS.some((p) => p.test(text))) return null;
  const topic = text.slice(0, 80).trim() || 'our conversation';
  return {
    topic,
    resumeLine: `Yesterday we were working on ${topic.toLowerCase().replace(/\.$/, '')}.`,
  };
}

export class FutureConversationsService {
  constructor(private readonly storage: IStorageService) {}

  async list(userId: EntityId): Promise<FutureConversation[]> {
    const map = (await this.storage.getItem<Record<string, FutureConversation[]>>(STORAGE_KEYS.futureConversations)) ?? {};
    return (map[userId] ?? []).filter((f) => !f.resolved);
  }

  async getDueToday(userId: EntityId): Promise<FutureConversation | null> {
    const today = new Date().toISOString().slice(0, 10);
    const items = await this.list(userId);
    return items.find((f) => (f.scheduledFor ?? '').slice(0, 10) <= today) ?? null;
  }

  async schedule(input: {
    userId: EntityId;
    conversationId: EntityId;
    userMessage: string;
  }): Promise<FutureConversation | null> {
    const detected = detectFutureConversation(input.userMessage);
    if (!detected) return null;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const entry: FutureConversation = {
      id: createUuid(),
      userId: input.userId,
      conversationId: input.conversationId,
      topic: detected.topic,
      resumeLine: detected.resumeLine,
      scheduledFor: tomorrow.toISOString(),
      createdAt: nowIso(),
      resolved: false,
    };

    const items = await this.list(input.userId);
    await this.save(input.userId, [entry, ...items]);
    return entry;
  }

  async resolve(userId: EntityId, id: EntityId): Promise<void> {
    const map = (await this.storage.getItem<Record<string, FutureConversation[]>>(STORAGE_KEYS.futureConversations)) ?? {};
    const items = (map[userId] ?? []).map((f) => (f.id === id ? { ...f, resolved: true } : f));
    map[userId] = items;
    await this.storage.setItem(STORAGE_KEYS.futureConversations, map);
  }

  private async save(userId: EntityId, items: FutureConversation[]) {
    const map = (await this.storage.getItem<Record<string, FutureConversation[]>>(STORAGE_KEYS.futureConversations)) ?? {};
    map[userId] = items.slice(0, 20);
    await this.storage.setItem(STORAGE_KEYS.futureConversations, map);
  }
}

let instance: FutureConversationsService | null = null;

export function getFutureConversationsService(storage: IStorageService) {
  if (!instance) instance = new FutureConversationsService(storage);
  return instance;
}
