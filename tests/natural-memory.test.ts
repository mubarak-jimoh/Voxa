import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeAIService } from '../src/services/ai/fake-ai-service';
import { createDefaultCompanionIdentity } from '../src/constants/companion-identity';
import { createDefaultCompanionControls } from '../src/types/relationship-personality';
import { createDefaultSubscription } from '../src/types/subscription';
import { STORAGE_KEYS } from '../src/constants/storage-keys';
import { LocalMemoryRepository } from '../src/services/local/local-memory-repository';
import { extractMemoriesLocally } from '../src/services/memory/local-memory-extractor';
import { MemoryIntelligenceService } from '../src/services/memory/memory-intelligence-service';
import { assessMemoryWrite } from '../src/services/memory/memory-write-policy';
import { IStorageService } from '../src/services/contracts';
import { Memory, UserProfile } from '../src/types';

class MemoryStorage implements IStorageService {
  private data = new Map<string, unknown>([[STORAGE_KEYS.memories, [] as Memory[]]]);
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

function profile(memoryEnabled = true): UserProfile {
  return {
    id: 'user-1',
    displayName: 'Alex',
    timezone: 'Europe/London',
    onboardingComplete: true,
    preferences: {
      voicePersonality: 'warm_calm',
      memoryEnabled,
      checkInStyle: 'gentle',
      proactiveVoiceCalls: false,
      hapticsEnabled: true,
      ambientGlowEnabled: true,
      selectedVoiceOptionId: 'aurora',
      companionControls: createDefaultCompanionControls(),
    },
    companion: { defaultMode: 'friend', lastUsedMode: 'friend' },
    companionIdentity: createDefaultCompanionIdentity(),
    subscription: createDefaultSubscription(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const NATURAL = [
  'My lucky number 15',
  'My lucky number is 15.',
  'My favourite colour is blue.',
  'My favourite food is jollof rice.',
  'I study computer science.',
  'I support Arsenal.',
  "My dog's name is Milo.",
  'I usually go to the gym after uni.',
];

describe('natural durable personal facts', () => {
  it('persists obvious first-person facts without remember that', () => {
    for (const message of NATURAL) {
      const decision = assessMemoryWrite(message);
      assert.equal(decision?.shouldPersist, true, message);
      assert.ok(extractMemoriesLocally({
        userMessage: message,
        voxaReply: 'Nice.',
        mode: 'friend',
        existingMemories: [],
      }).length > 0, message);
    }
  });

  it('still persists explicit remember that', () => {
    const decision = assessMemoryWrite('My test colour is green. Remember that.');
    assert.equal(decision?.shouldPersist, true);
    assert.equal(decision?.reason, 'explicit_remember_request');
  });

  it('does not persist questions, live info, moods, third-person facts, or photos', () => {
    const skip = [
      "What's my lucky number",
      "Who's top of the Premier League?",
      "I'm tired",
      "Her lucky number is 15",
      '[Photo shared]',
      'lol whatever',
    ];
    for (const message of skip) {
      assert.equal(assessMemoryWrite(message)?.shouldPersist ?? false, false, message);
    }
  });

  it('processAfterReply saves a natural fact and respects memory off and account isolation', async () => {
    const storage = new MemoryStorage();
    const repo = new LocalMemoryRepository(storage);
    const engine = new MemoryIntelligenceService(repo, new FakeAIService());

    const saved = await engine.processAfterReply({
      userId: 'user-a',
      userMessage: 'My lucky number 15',
      voxaReply: 'Nice! Lucky number 15, huh?',
      mode: 'friend',
      userProfile: { ...profile(true), id: 'user-a' },
    });
    assert.ok(saved.some((item) => /lucky number/i.test(item.content)));
    assert.equal((await repo.listMemories('user-b')).length, 0);
    assert.ok((await repo.listMemories('user-a')).length > 0);

    const off = await engine.processAfterReply({
      userId: 'user-a',
      userMessage: 'My favourite colour is blue.',
      voxaReply: 'Noted.',
      mode: 'friend',
      userProfile: { ...profile(false), id: 'user-a' },
    });
    assert.deepEqual(off, []);
  });
});
