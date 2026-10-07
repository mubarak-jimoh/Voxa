import { STORAGE_KEYS } from '../../constants/storage-keys';
import { createUuid, EntityId, nowIso } from '../../types';
import { PhotoMemory, PhotoMemoryCategory } from '../../types/phase12-experiences';
import { IStorageService } from '../contracts';

export class PhotoMemoryService {
  constructor(private readonly storage: IStorageService) {}

  async list(userId: EntityId, opts?: { includePrivate?: boolean }): Promise<PhotoMemory[]> {
    const map = (await this.storage.getItem<Record<string, PhotoMemory[]>>(STORAGE_KEYS.photoMemories)) ?? {};
    let items = map[userId] ?? [];
    if (!opts?.includePrivate) items = items.filter((p) => !p.isPrivate);
    return items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  async get(userId: EntityId, id: EntityId): Promise<PhotoMemory | null> {
    return (await this.list(userId, { includePrivate: true })).find((p) => p.id === id) ?? null;
  }

  async findExisting(
    userId: EntityId,
    match: { localUri?: string; remoteUrl?: string; memoryId?: string },
  ): Promise<PhotoMemory | null> {
    const items = await this.list(userId, { includePrivate: true });
    return (
      items.find((photo) => {
        if (match.memoryId && photo.memoryId === match.memoryId) return true;
        if (match.localUri && photo.localUri === match.localUri) return true;
        if (match.remoteUrl && photo.remoteUrl === match.remoteUrl) return true;
        return false;
      }) ?? null
    );
  }

  async create(userId: EntityId, input: Omit<PhotoMemory, 'id' | 'userId' | 'createdAt' | 'updatedAt'>): Promise<PhotoMemory> {
    const photo: PhotoMemory = { ...input, id: createUuid(), userId, createdAt: nowIso(), updatedAt: nowIso() };
    await this.upsert(userId, photo);
    return photo;
  }

  async update(userId: EntityId, photo: PhotoMemory): Promise<PhotoMemory> {
    const updated = { ...photo, updatedAt: nowIso() };
    await this.upsert(userId, updated);
    return updated;
  }

  async delete(userId: EntityId, id: EntityId): Promise<void> {
    const map = (await this.storage.getItem<Record<string, PhotoMemory[]>>(STORAGE_KEYS.photoMemories)) ?? {};
    map[userId] = (map[userId] ?? []).filter((p) => p.id !== id);
    await this.storage.setItem(STORAGE_KEYS.photoMemories, map);
  }

  async onThisDay(userId: EntityId): Promise<PhotoMemory | null> {
    const today = new Date();
    const md = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const items = await this.list(userId);
    return items.find((p) => p.occurredAt.slice(5, 10) === md) ?? null;
  }

  async filter(userId: EntityId, query: { category?: PhotoMemoryCategory; favourite?: boolean; search?: string }): Promise<PhotoMemory[]> {
    let items = await this.list(userId, { includePrivate: true });
    if (query.category) items = items.filter((p) => p.category === query.category);
    if (query.favourite) items = items.filter((p) => p.favourite);
    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter((p) => `${p.title} ${p.caption} ${p.placeText ?? ''}`.toLowerCase().includes(q));
    }
    return items;
  }

  resolveUri(photo: PhotoMemory): string | null {
    if (photo.localUri) return photo.localUri;
    if (photo.remoteUrl) return photo.remoteUrl;
    return photo.thumbnailUri ?? null;
  }

  referenceLine(photo: PhotoMemory): string {
    const when = new Date(photo.occurredAt);
    const ago = Math.floor((Date.now() - when.getTime()) / 86400000);
    const timeLabel = ago < 35 ? 'last month' : ago < 400 ? 'a while back' : 'some time ago';
    return `This reminds me of "${photo.title}" — the ${photo.category.replace('_', ' ')} photo you saved ${timeLabel}.`;
  }

  private async upsert(userId: EntityId, photo: PhotoMemory): Promise<void> {
    const map = (await this.storage.getItem<Record<string, PhotoMemory[]>>(STORAGE_KEYS.photoMemories)) ?? {};
    const items = map[userId] ?? [];
    const idx = items.findIndex((p) => p.id === photo.id);
    if (idx >= 0) items[idx] = photo;
    else items.unshift(photo);
    map[userId] = items.slice(0, 200);
    await this.storage.setItem(STORAGE_KEYS.photoMemories, map);
  }
}

let instance: PhotoMemoryService | null = null;
let boundStorage: IStorageService | null = null;

export function getPhotoMemoryService(storage: IStorageService) {
  if (!instance || boundStorage !== storage) {
    instance = new PhotoMemoryService(storage);
    boundStorage = storage;
  }
  return instance;
}

export function resetPhotoMemoryServiceForTests() {
  instance = null;
  boundStorage = null;
}

export const PHOTO_CATEGORIES: Array<{ id: PhotoMemoryCategory; label: string }> = [
  { id: 'achievement', label: 'Achievement' },
  { id: 'fitness', label: 'Fitness' },
  { id: 'family', label: 'Family' },
  { id: 'friends', label: 'Friends' },
  { id: 'travel', label: 'Travel' },
  { id: 'food', label: 'Food' },
  { id: 'pet', label: 'Pet' },
  { id: 'work', label: 'Work' },
  { id: 'education', label: 'Education' },
  { id: 'celebration', label: 'Celebration' },
  { id: 'everyday', label: 'Everyday life' },
  { id: 'custom', label: 'Custom' },
];
