import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyTalkIntent } from '../src/services/ai/companion-intent';
import { FakeAIService } from '../src/services/ai/fake-ai-service';
import { talkIntentSkipsMemoryRetrieval } from '../src/services/chat/talk-critical-path';
import { LocalMemoryRepository } from '../src/services/local/local-memory-repository';
import { decideMemoryCallback } from '../src/services/memory/memory-callback-gate';
import { eventsLikelySame, findDuplicateMemory } from '../src/services/memory/memory-deduplication';
import { extractMemoriesLocally } from '../src/services/memory/local-memory-extractor';
import { isDurableEnoughToStore } from '../src/services/memory/memory-quality';
import { filterMemoriesForIntent, rankMemories } from '../src/services/memory/memory-relevance';
import { detectMemorySensitivity } from '../src/services/memory/memory-sensitivity';
import {
  findSupersessionTargets,
  shouldReplaceInsteadOfMerge,
} from '../src/services/memory/memory-supersession';
import { TAG_EXPLICIT, TAG_SUPERSEDED, isSupersededMemory } from '../src/services/memory/memory-taxonomy';
import { readTemporalMeta, tagsFromParsedTemporal } from '../src/services/memory/temporal-memory';
import {
  instantToZoned,
  localDayIso,
  parseTemporalExpressions,
  resolveFridaySemantics,
  zonedLocalToUtc,
} from '../src/services/memory/temporal-parse';
import { assessMemoryWrite, enrichCandidateDecision } from '../src/services/memory/memory-write-policy';
import { buildSupersededPatch } from '../src/services/memory/memory-supersession';
import { IStorageService } from '../src/services/contracts';
import { memoryFromRow, memoryToInsert } from '../src/services/supabase/mappers';
import { Memory } from '../src/types';

const LONDON = 'Europe/London';
const CHICAGO = 'America/Chicago';

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

/** Monday 7 Sep 2026 15:00 BST (UTC+1). */
const MON_7_SEP = new Date('2026-09-07T14:00:00.000Z');
/** Friday 11 Sep 2026 15:00 BST. */
const FRI_11_SEP = new Date('2026-09-11T14:00:00.000Z');
/** Saturday 12 Sep 2026 11:00 BST. */
const SAT_12_SEP = new Date('2026-09-12T10:00:00.000Z');

function memory(
  title: string,
  content: string,
  overrides: Partial<Memory> = {},
): Memory {
  return {
    id: `m-${title}`,
    userId: 'user-1',
    category: 'moments',
    title,
    content,
    mood: 'neutral',
    importance: 4,
    tags: [TAG_EXPLICIT],
    source: 'conversation',
    useCount: 0,
    confidence: 0.92,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function dayOf(parsed: NonNullable<ReturnType<typeof parseTemporalExpressions>>, tz = LONDON): string {
  return localDayIso(new Date(parsed.occurredAt), tz);
}

describe('Phase 2A temporal parse', () => {
  it('resolves tomorrow from a London Monday in BST', () => {
    const parsed = parseTemporalExpressions("It's tomorrow", { now: MON_7_SEP, timeZone: LONDON });
    assert.ok(parsed);
    assert.equal(dayOf(parsed!), '2026-09-08');
    assert.equal(parsed!.precision, 'day');
    assert.equal(parsed!.temporalConfidence, 'high');
    const zoned = instantToZoned(new Date(parsed!.occurredAt), LONDON);
    assert.equal(zoned.hour, 0);
    assert.equal(zoned.minute, 0);
  });

  it('Monday Friday vs next Friday semantics', () => {
    const friday = parseTemporalExpressions('My test is Friday', { now: MON_7_SEP, timeZone: LONDON });
    const nextFriday = parseTemporalExpressions('My test is next Friday', {
      now: MON_7_SEP,
      timeZone: LONDON,
    });
    assert.equal(dayOf(friday!), '2026-09-11');
    assert.equal(dayOf(nextFriday!), '2026-09-18');
  });

  it('Friday Friday vs next Friday semantics', () => {
    const friday = parseTemporalExpressions('Friday', { now: FRI_11_SEP, timeZone: LONDON });
    const nextFriday = parseTemporalExpressions('next Friday', { now: FRI_11_SEP, timeZone: LONDON });
    assert.equal(dayOf(friday!), '2026-09-11');
    assert.equal(dayOf(nextFriday!), '2026-09-18');
    const zoned = instantToZoned(FRI_11_SEP, LONDON);
    assert.deepEqual(resolveFridaySemantics(zoned, 'friday'), { year: 2026, month: 9, day: 11 });
    assert.deepEqual(resolveFridaySemantics(zoned, 'next_friday'), { year: 2026, month: 9, day: 18 });
  });

  it('Saturday weekend and Friday semantics', () => {
    const weekend = parseTemporalExpressions('this weekend', { now: SAT_12_SEP, timeZone: LONDON });
    const friday = parseTemporalExpressions('Friday', { now: SAT_12_SEP, timeZone: LONDON });
    const nextFriday = parseTemporalExpressions('next Friday', { now: SAT_12_SEP, timeZone: LONDON });
    assert.equal(dayOf(weekend!), '2026-09-12');
    assert.equal(localDayIso(new Date(weekend!.endsAt!), LONDON), '2026-09-13');
    assert.equal(dayOf(friday!), '2026-09-18');
    assert.equal(dayOf(nextFriday!), '2026-09-18');
  });

  it('resolves tonight, yesterday, in 2 days, next week, at 2 tomorrow', () => {
    const today = parseTemporalExpressions('today', { now: MON_7_SEP, timeZone: LONDON });
    const tonight = parseTemporalExpressions('see you tonight', { now: MON_7_SEP, timeZone: LONDON });
    const yesterday = parseTemporalExpressions('yesterday was busy', { now: MON_7_SEP, timeZone: LONDON });
    const inTwo = parseTemporalExpressions('in 2 days', { now: MON_7_SEP, timeZone: LONDON });
    const fewHours = parseTemporalExpressions('in a few hours', { now: MON_7_SEP, timeZone: LONDON });
    const nextWeek = parseTemporalExpressions('next week', { now: MON_7_SEP, timeZone: LONDON });
    const atTwo = parseTemporalExpressions('at 2 tomorrow', { now: MON_7_SEP, timeZone: LONDON });
    const thisMorning = parseTemporalExpressions('this morning', { now: MON_7_SEP, timeZone: LONDON });
    const thisAfternoon = parseTemporalExpressions('this afternoon', { now: MON_7_SEP, timeZone: LONDON });
    const laterToday = parseTemporalExpressions('later today', { now: MON_7_SEP, timeZone: LONDON });

    assert.equal(dayOf(today!), '2026-09-07');
    assert.equal(today!.precision, 'day');
    assert.equal(dayOf(tonight!), '2026-09-07');
    assert.equal(tonight!.precision, 'range');
    assert.equal(dayOf(yesterday!), '2026-09-06');
    assert.equal(yesterday!.isPastEvent, true);
    assert.equal(dayOf(inTwo!), '2026-09-09');
    assert.ok(fewHours);
    assert.equal(fewHours!.precision, 'vague');
    assert.equal(fewHours!.temporalConfidence, 'low');
    assert.equal(dayOf(nextWeek!), '2026-09-14');
    assert.equal(nextWeek!.precision, 'range');
    assert.equal(dayOf(atTwo!), '2026-09-08');
    assert.equal(atTwo!.precision, 'time');
    const clock = instantToZoned(new Date(atTwo!.occurredAt), LONDON);
    assert.equal(clock.hour, 14);
    assert.equal(clock.minute, 0);
    assert.equal(thisMorning!.precision, 'range');
    assert.equal(thisAfternoon!.precision, 'range');
    assert.equal(laterToday!.precision, 'range');
    assert.equal(dayOf(thisMorning!), '2026-09-07');
  });

  it('does not fake precision for in a few days', () => {
    const parsed = parseTemporalExpressions('maybe in a few days', { now: MON_7_SEP, timeZone: LONDON });
    assert.ok(parsed);
    assert.equal(parsed!.precision, 'vague');
    assert.equal(parsed!.temporalConfidence, 'low');
    const zoned = instantToZoned(new Date(parsed!.occurredAt), LONDON);
    assert.equal(zoned.hour, 0);
    assert.equal(zoned.minute, 0);
    assert.ok(!parsed!.label.includes('14:37'));
  });

  it('month, year, and leap-year boundaries', () => {
    const monthEnd = parseTemporalExpressions('tomorrow', {
      now: new Date('2026-09-30T14:00:00.000Z'),
      timeZone: LONDON,
    });
    const yearEnd = parseTemporalExpressions('tomorrow', {
      now: new Date('2026-12-31T12:00:00.000Z'),
      timeZone: LONDON,
    });
    const leap = parseTemporalExpressions('tomorrow', {
      now: zonedLocalToUtc(LONDON, 2024, 2, 28, 15, 0, 0),
      timeZone: LONDON,
    });
    assert.equal(dayOf(monthEnd!), '2026-10-01');
    assert.equal(dayOf(yearEnd!), '2027-01-01');
    assert.equal(dayOf(leap!), '2024-02-29');
  });

  it('handles BST and GMT around the 2026 UK fallback', () => {
    const bst = parseTemporalExpressions('tomorrow', {
      now: new Date('2026-10-24T14:00:00.000Z'),
      timeZone: LONDON,
    });
    const gmt = parseTemporalExpressions('tomorrow', {
      now: new Date('2026-10-25T15:00:00.000Z'),
      timeZone: LONDON,
    });
    assert.equal(dayOf(bst!), '2026-10-25');
    assert.equal(dayOf(gmt!), '2026-10-26');
    const bstOffset = instantToZoned(new Date('2026-09-07T14:00:00.000Z'), LONDON);
    const gmtOffset = instantToZoned(new Date('2026-11-07T14:00:00.000Z'), LONDON);
    assert.equal(bstOffset.hour, 15);
    assert.equal(gmtOffset.hour, 14);
  });

  it('does not hardcode London as the product timezone', () => {
    const now = new Date('2026-09-07T04:30:00.000Z');
    const londonTomorrow = parseTemporalExpressions('tomorrow', { now, timeZone: LONDON });
    const chicagoTomorrow = parseTemporalExpressions('tomorrow', { now, timeZone: CHICAGO });
    assert.equal(dayOf(londonTomorrow!, LONDON), '2026-09-08');
    assert.equal(dayOf(chicagoTomorrow!, CHICAGO), '2026-09-07');
  });
});

describe('Phase 2A confidence, quality, identity', () => {
  it('lowers confidence for hedged temporal facts', () => {
    const certain = assessMemoryWrite('My driving test is Friday', {
      now: MON_7_SEP,
      timeZone: LONDON,
    });
    const think = assessMemoryWrite('I think my test is Friday', {
      now: MON_7_SEP,
      timeZone: LONDON,
    });
    const maybe = assessMemoryWrite('maybe next week I have a driving test', {
      now: MON_7_SEP,
      timeZone: LONDON,
    });
    assert.ok(certain && certain.confidenceScore >= 0.85);
    assert.ok(think && think.confidenceScore < certain!.confidenceScore);
    assert.ok(maybe && maybe.confidenceScore <= 0.52);
    assert.equal(readTemporalMeta({ tags: maybe!.tags } as Memory).temporalConfidence, 'low');
  });

  it('skips ephemeral chatter and extracts durable facts', () => {
    assert.equal(isDurableEnoughToStore("I'm tired"), false);
    assert.equal(isDurableEnoughToStore('lol'), false);
    assert.equal(isDurableEnoughToStore('17x24'), false);
    assert.equal(extractMemoriesLocally({
      userMessage: "I'm tired",
      voxaReply: 'Rest up.',
      mode: 'friend',
      existingMemories: [],
    }).length, 0);
    const boxed = extractMemoriesLocally({
      userMessage: 'I box three times a week',
      voxaReply: 'Nice.',
      mode: 'friend',
      existingMemories: [],
    });
    assert.ok(boxed.length > 0);
  });

  it('dedupes the same event phrased differently', () => {
    assert.ok(
      eventsLikelySame(
        'Driving test',
        'Driving test Friday',
        'Upcoming event',
        'My driving test is on Friday',
      ),
    );
    const existing = [
      memory('Driving test', 'Driving test Friday', {
        category: 'moments',
        occurredAt: parseTemporalExpressions('Friday', { now: MON_7_SEP, timeZone: LONDON })!.occurredAt,
      }),
    ];
    const duplicate = findDuplicateMemory(existing, {
      category: 'moments',
      title: 'Upcoming event',
      content: 'My driving test is on Friday',
      importance: 4,
      mood: 'neutral',
      tags: [],
    });
    assert.ok(duplicate);
  });

  it('does not merge unrelated keyword overlap', () => {
    assert.equal(
      eventsLikelySame('Boxing', 'I box three times a week', 'Driving test', 'Driving test Friday'),
      false,
    );
  });

  it('supersedes a moved event and keeps history', () => {
    const friday = parseTemporalExpressions('Friday', { now: MON_7_SEP, timeZone: LONDON })!;
    const existing = [
      memory('Driving test', 'My driving test is Friday', {
        occurredAt: friday.occurredAt,
        tags: [TAG_EXPLICIT, ...tagsFromParsedTemporal(friday)],
      }),
    ];
    const decision = assessMemoryWrite('They moved my driving test to Monday', {
      now: MON_7_SEP,
      timeZone: LONDON,
    });
    assert.ok(decision);
    const { target } = findSupersessionTargets(existing, decision!);
    assert.ok(target);
    assert.equal(shouldReplaceInsteadOfMerge(decision!, target!), true);
    const patch = buildSupersededPatch(existing[0]);
    assert.ok(patch.tags?.includes(TAG_SUPERSEDED));
    assert.equal(isSupersededMemory({ ...existing[0], tags: patch.tags as string[] }), true);
  });

  it('expires a temporary event after its date', () => {
    const parsed = parseTemporalExpressions('My exam is tomorrow', { now: MON_7_SEP, timeZone: LONDON })!;
    const expired = memory('Exam', 'My exam is tomorrow', {
      expiresAt: parsed.expiresAt,
      occurredAt: parsed.occurredAt,
    });
    const after = rankMemories([expired], {
      userMessage: 'exam',
      mode: 'friend',
      now: new Date('2026-09-10T12:00:00.000Z'),
      timeZone: LONDON,
    });
    assert.equal(after.length, 0);
  });
});

describe('Phase 2A retrieval and callback gate', () => {
  it('relevant temporal memory wins and weak unrelated memory loses', () => {
    const friday = parseTemporalExpressions('Friday', { now: MON_7_SEP, timeZone: LONDON })!;
    const driving = memory('Driving test', 'My driving test is Friday', {
      occurredAt: friday.occurredAt,
      tags: [TAG_EXPLICIT, ...tagsFromParsedTemporal(friday)],
      confidence: 0.92,
    });
    const boxing = memory('Boxing', 'I box three times a week', {
      category: 'fitness',
      occurredAt: undefined,
      tags: [TAG_EXPLICIT],
    });
    const ranked = rankMemories([driving, boxing], {
      userMessage: "I'm nervous for tomorrow",
      mode: 'friend',
      now: new Date('2026-09-10T14:00:00.000Z'),
      timeZone: LONDON,
    });
    assert.ok(ranked[0]?.memory.title.includes('Driving'));
    const math = rankMemories([boxing], {
      userMessage: "What's 17x24?",
      mode: 'friend',
      now: MON_7_SEP,
      timeZone: LONDON,
    });
    assert.equal(filterMemoriesForIntent(math, 'factual_question', "What's 17x24?").length, 0);
  });

  it('callback mention / silent / ignore matrix', () => {
    const friday = parseTemporalExpressions('Friday', { now: MON_7_SEP, timeZone: LONDON })!;
    const driving = memory('Driving test', 'My driving test is Friday', {
      occurredAt: friday.occurredAt,
      tags: [TAG_EXPLICIT, ...tagsFromParsedTemporal(friday)],
      confidence: 0.92,
    });
    const boxing = memory('Boxing', 'I box three times a week', {
      category: 'fitness',
      tags: [TAG_EXPLICIT],
    });
    const weak = memory('Maybe test', 'I think my test might be Friday', {
      occurredAt: friday.occurredAt,
      tags: ['inferred', ...tagsFromParsedTemporal({ ...friday, temporalConfidence: 'low' })],
      confidence: 0.4,
    });
    const sensitive = memory('Health', 'diagnosed last year', {
      category: 'emotional',
      tags: ['sensitive', TAG_EXPLICIT],
    });

    const tomorrow = parseTemporalExpressions('tomorrow', {
      now: new Date('2026-09-10T14:00:00.000Z'),
      timeZone: LONDON,
    });

    assert.equal(
      decideMemoryCallback({
        memory: driving,
        userMessage: "I'm nervous for tomorrow",
        intent: 'emotional_support',
        memoryPolicy: 'recall',
        now: new Date('2026-09-10T14:00:00.000Z'),
        timeZone: LONDON,
        queryTemporal: tomorrow,
        keywordOverlap: 0,
        temporalAlign: true,
        ambiguousTemporalMatch: false,
      }),
      'mention',
    );

    assert.equal(
      decideMemoryCallback({
        memory: boxing,
        userMessage: "What's 17x24?",
        intent: 'factual_question',
        memoryPolicy: 'skip',
        keywordOverlap: 0,
        temporalAlign: false,
        ambiguousTemporalMatch: false,
      }),
      'ignore',
    );

    assert.equal(
      decideMemoryCallback({
        memory: boxing,
        userMessage: 'how is boxing going',
        intent: 'casual_conversation',
        memoryPolicy: 'high_confidence_only',
        keywordOverlap: 0.5,
        temporalAlign: false,
        ambiguousTemporalMatch: false,
      }),
      'use_silently',
    );

    assert.equal(
      decideMemoryCallback({
        memory: driving,
        userMessage: "I'm tired",
        intent: 'casual_conversation',
        memoryPolicy: 'high_confidence_only',
        now: MON_7_SEP,
        timeZone: LONDON,
        queryTemporal: null,
        keywordOverlap: 0,
        temporalAlign: false,
        ambiguousTemporalMatch: false,
      }),
      'ignore',
    );

    assert.equal(
      decideMemoryCallback({
        memory: weak,
        userMessage: "I'm nervous for tomorrow",
        intent: 'emotional_support',
        memoryPolicy: 'recall',
        queryTemporal: tomorrow,
        keywordOverlap: 0.1,
        temporalAlign: true,
        ambiguousTemporalMatch: false,
      }),
      'ignore',
    );

    assert.equal(
      decideMemoryCallback({
        memory: sensitive,
        userMessage: "I'm tired",
        intent: 'casual_conversation',
        memoryPolicy: 'high_confidence_only',
        keywordOverlap: 0,
        temporalAlign: false,
        ambiguousTemporalMatch: false,
      }),
      'ignore',
    );
  });

  it('does not casually collect sensitive or journal material', () => {
    assert.equal(detectMemorySensitivity('I was diagnosed last year'), 'health');
    assert.equal(assessMemoryWrite('I was diagnosed last year'), null);
    assert.ok(assessMemoryWrite('Remember that I was diagnosed last year')?.shouldPersist);
    assert.equal(detectMemorySensitivity('in my journal I wrote about dad'), 'journal');
  });
});

describe('Phase 2A persistence and Talk contract', () => {
  it('confidence, expiresAt, occurredAt and temporal tags survive local round trip', async () => {
    const parsed = parseTemporalExpressions('My driving test is Friday', {
      now: MON_7_SEP,
      timeZone: LONDON,
    })!;
    const repo = new LocalMemoryRepository(new MemoryStorage());
    const created = await repo.createMemory({
      userId: 'user-1',
      category: 'moments',
      title: 'Driving test',
      content: 'My driving test is Friday',
      confidence: 0.91,
      expiresAt: parsed.expiresAt,
      occurredAt: parsed.occurredAt,
      emotionalSignificance: 4,
      tags: tagsFromParsedTemporal(parsed),
    });
    const listed = await repo.listMemories('user-1');
    assert.equal(listed[0]?.confidence, 0.91);
    assert.equal(listed[0]?.expiresAt, parsed.expiresAt);
    assert.equal(listed[0]?.occurredAt, parsed.occurredAt);
    assert.equal(listed[0]?.emotionalSignificance, 4);
    assert.ok(listed[0]?.tags.includes('tprec:day'));
    assert.equal(created.id, listed[0]?.id);

    const updated = await repo.updateMemory(created.id, {
      confidence: 0.88,
      expiresAt: parsed.expiresAt,
      occurredAt: parsed.occurredAt,
    });
    assert.equal(updated.confidence, 0.88);
    assert.equal(updated.expiresAt, parsed.expiresAt);
    const again = await repo.listMemories('user-1');
    assert.equal(again[0]?.confidence, 0.88);
    assert.equal(again[0]?.expiresAt, parsed.expiresAt);

    const row = memoryToInsert(
      {
        userId: 'user-1',
        category: 'moments',
        title: 'Driving test',
        content: 'My driving test is Friday',
        confidence: 0.91,
        expiresAt: parsed.expiresAt,
        occurredAt: parsed.occurredAt,
        emotionalSignificance: 4,
        tags: tagsFromParsedTemporal(parsed),
      },
      'memory-remote',
      '2026-09-07T14:00:00.000Z',
    );
    const remote = memoryFromRow(row);
    assert.equal(remote.confidence, 0.91);
    assert.equal(remote.expiresAt, parsed.expiresAt);
    assert.equal(remote.occurredAt, parsed.occurredAt);
    assert.ok(remote.tags.includes('tprec:day'));
  });

  it('normal Talk factual turns still skip memory work and gateway extraction stays local', async () => {
    assert.equal(talkIntentSkipsMemoryRetrieval(classifyTalkIntent("What's 17x24?").intent), true);
    const extractor = new FakeAIService();
    const extracted = await extractor.extractMemoriesFromExchange({
      userMessage: "What's 17x24?",
      voxaReply: '408',
      mode: 'friend',
      userProfile: {
        id: 'user-1',
        displayName: 'Alex',
        timezone: LONDON,
        onboardingComplete: true,
        preferences: {
          voicePersonality: 'warm_calm',
          memoryEnabled: true,
          checkInStyle: 'gentle',
          proactiveVoiceCalls: false,
          hapticsEnabled: true,
          ambientGlowEnabled: true,
          selectedVoiceOptionId: 'aurora',
        },
        companion: { defaultMode: 'friend', lastUsedMode: 'friend' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as never,
      existingMemories: [],
    });
    assert.equal(extracted.length, 0);
  });

  it('temporal parse and callback stay cheap', () => {
    const started = Date.now();
    for (let i = 0; i < 400; i += 1) {
      const parsed = parseTemporalExpressions('My driving test is Friday', {
        now: MON_7_SEP,
        timeZone: LONDON,
      })!;
      const driving = memory('Driving test', 'My driving test is Friday', {
        occurredAt: parsed.occurredAt,
        tags: tagsFromParsedTemporal(parsed),
      });
      rankMemories([driving], {
        userMessage: "I'm nervous for tomorrow",
        mode: 'friend',
        now: new Date('2026-09-10T14:00:00.000Z'),
        timeZone: LONDON,
      });
      decideMemoryCallback({
        memory: driving,
        userMessage: "I'm nervous for tomorrow",
        intent: 'emotional_support',
        memoryPolicy: 'recall',
        keywordOverlap: 0,
        temporalAlign: true,
        ambiguousTemporalMatch: false,
      });
    }
    assert.ok(Date.now() - started < 10_000);
  });
});
