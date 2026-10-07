import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyTalkIntent } from '../src/services/ai/companion-intent';
import { FakeAIService } from '../src/services/ai/fake-ai-service';
import { formatMemoriesForPrompt } from '../src/services/ai/voxa-system-prompt';
import { talkIntentSkipsMemoryRetrieval } from '../src/services/chat/talk-critical-path';
import { decideMemoryCallback } from '../src/services/memory/memory-callback-gate';
import { assessMemoryWrite } from '../src/services/memory/memory-write-policy';
import { filterMemoriesForIntent, rankMemories } from '../src/services/memory/memory-relevance';
import { detectMemorySensitivity } from '../src/services/memory/memory-sensitivity';
import { TAG_EXPLICIT, TAG_OPEN_LOOP, TAG_RESOLVED, isSupersededMemory } from '../src/services/memory/memory-taxonomy';
import { tagsFromParsedTemporal } from '../src/services/memory/temporal-memory';
import { parseTemporalExpressions } from '../src/services/memory/temporal-parse';
import {
  applyOpenLoopLifecycle,
  detectConversationalAbandon,
  detectEventCancellation,
  isOpenLoopEligible,
  joinOpenLoops,
  readOpenLoopStatus,
  resolveActiveTopic,
} from '../src/services/memory/open-loop-service';
import { Memory } from '../src/types';

const LONDON = 'Europe/London';
const THU_10_SEP = new Date('2026-09-10T14:00:00.000Z');
const FRI_11_SEP = new Date('2026-09-11T14:00:00.000Z');
const SAT_12_SEP = new Date('2026-09-12T10:00:00.000Z');

function memory(title: string, content: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id: `m-${title}`,
    userId: 'user-1',
    category: 'moments',
    title,
    content,
    mood: 'neutral',
    importance: 4,
    tags: [TAG_EXPLICIT, TAG_OPEN_LOOP],
    source: 'conversation',
    useCount: 0,
    confidence: 0.92,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function drivingTomorrow(): Memory {
  const parsed = parseTemporalExpressions('tomorrow', { now: THU_10_SEP, timeZone: LONDON })!;
  return memory('Driving test', 'My driving test is tomorrow', {
    occurredAt: parsed.occurredAt,
    expiresAt: parsed.expiresAt,
    tags: [TAG_EXPLICIT, TAG_OPEN_LOOP, ...tagsFromParsedTemporal(parsed)],
  });
}

function interviewTomorrow(): Memory {
  const parsed = parseTemporalExpressions('tomorrow', { now: THU_10_SEP, timeZone: LONDON })!;
  return memory('Interview', 'I have an interview tomorrow', {
    id: 'm-Interview',
    occurredAt: parsed.occurredAt,
    expiresAt: parsed.expiresAt,
    tags: [TAG_EXPLICIT, TAG_OPEN_LOOP, ...tagsFromParsedTemporal(parsed)],
  });
}

describe('Phase 2B open-loop eligibility', () => {
  it('creates one eligible open loop for a driving test', () => {
    const text = "I've got my driving test Friday";
    assert.equal(isOpenLoopEligible(text), true);
    const decision = assessMemoryWrite(text, { now: THU_10_SEP, timeZone: LONDON });
    assert.ok(decision?.shouldPersist);
    assert.ok(decision?.tags.includes(TAG_OPEN_LOOP));
  });

  it('does not create an open loop for liking Fridays', () => {
    assert.equal(isOpenLoopEligible('I like Fridays'), false);
    const decision = assessMemoryWrite('I like Fridays', { now: THU_10_SEP, timeZone: LONDON });
    assert.equal(decision?.tags.includes(TAG_OPEN_LOOP) ?? false, false);
  });
});

describe('Phase 2B temporal join and ambiguity', () => {
  it('joins nervous-for-tomorrow to a unique driving test', () => {
    const driving = drivingTomorrow();
    const join = joinOpenLoops([driving], {
      userMessage: "I'm kinda nervous for tomorrow ngl",
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(join.unique, true);
    assert.equal(join.ambiguous, false);
    assert.equal(join.memory?.title, 'Driving test');
    assert.equal(classifyTalkIntent("I'm kinda nervous for tomorrow ngl").intent, 'emotional_support');

    const ranked = rankMemories([driving], {
      userMessage: "I'm kinda nervous for tomorrow ngl",
      mode: 'friend',
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.ok(ranked[0]?.memory.title.includes('Driving'));
    assert.equal(
      decideMemoryCallback({
        memory: driving,
        userMessage: "I'm kinda nervous for tomorrow ngl",
        intent: 'emotional_support',
        memoryPolicy: 'recall',
        now: THU_10_SEP,
        timeZone: LONDON,
        queryTemporal: parseTemporalExpressions('tomorrow', { now: THU_10_SEP, timeZone: LONDON }),
        keywordOverlap: 0,
        temporalAlign: true,
        ambiguousTemporalMatch: false,
        uniqueOpenLoop: true,
      }),
      'mention',
    );

    const prompt = formatMemoriesForPrompt({
      memories: [driving],
      userMessage: "I'm kinda nervous for tomorrow ngl",
      talkIntent: 'emotional_support',
      timeZone: LONDON,
      nowIso: THU_10_SEP.toISOString(),
    });
    assert.match(prompt, /Active event:/i);
    assert.match(prompt, /callback allowed/i);
    assert.doesNotMatch(prompt, /you previously told me/i);
    assert.doesNotMatch(prompt, /open_loop/);
  });

  it('does not pick an event when two tomorrow events compete', () => {
    const join = joinOpenLoops([drivingTomorrow(), interviewTomorrow()], {
      userMessage: "I'm nervous for tomorrow",
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(join.unique, false);
    assert.equal(join.ambiguous, true);
    assert.equal(
      decideMemoryCallback({
        memory: drivingTomorrow(),
        userMessage: "I'm nervous for tomorrow",
        intent: 'emotional_support',
        memoryPolicy: 'recall',
        keywordOverlap: 0,
        temporalAlign: true,
        ambiguousTemporalMatch: true,
        uniqueOpenLoop: false,
      }),
      'ignore',
    );
  });
});

describe('Phase 2B update, cancel, abandon, resolve', () => {
  it('keeps the same loop open when the test is moved', () => {
    const tomorrow = parseTemporalExpressions('tomorrow', { now: THU_10_SEP, timeZone: LONDON })!;
    const existing = [
      memory('Driving test', 'My driving test is tomorrow', {
        occurredAt: tomorrow.occurredAt,
        tags: [TAG_EXPLICIT, TAG_OPEN_LOOP, ...tagsFromParsedTemporal(tomorrow)],
      }),
    ];
    const decision = assessMemoryWrite('They moved my driving test to Monday', {
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.ok(decision?.shouldPersist);
    assert.ok(decision?.tags.includes(TAG_OPEN_LOOP));
    assert.ok(decision?.occurredAt);
    assert.notEqual(decision?.occurredAt, existing[0].occurredAt);
  });

  it('cancels a real-world event and does not treat forget-that as cancel', () => {
    const driving = drivingTomorrow();
    assert.equal(detectEventCancellation('My driving test got cancelled.'), true);
    const cancelled = applyOpenLoopLifecycle([driving], 'My driving test got cancelled.', {
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(cancelled.action, 'cancel');
    assert.equal(cancelled.suppressExtract, true);
    assert.ok(cancelled.patch?.tags?.includes('cancelled'));
    assert.equal(cancelled.patch?.tags?.includes(TAG_OPEN_LOOP), false);

    assert.equal(detectConversationalAbandon('forget that, let\'s talk about football'), true);
    const abandon = applyOpenLoopLifecycle([driving], 'forget that, let\'s talk about football', {
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(abandon.action, 'abandon');
    assert.equal(abandon.patch, null);
    assert.equal(isSupersededMemory(driving), false);
  });

  it('resolves an explicit pass and an implicit unique pass, but not an ambiguous pass', () => {
    const driving = drivingTomorrow();
    const explicit = applyOpenLoopLifecycle([driving], 'I passed my driving test', {
      now: FRI_11_SEP,
      timeZone: LONDON,
    });
    assert.equal(explicit.action, 'resolve');
    assert.ok(explicit.patch?.tags?.includes(TAG_RESOLVED));
    assert.ok(explicit.patch?.content?.toLowerCase().includes('passed'));

    const implicit = applyOpenLoopLifecycle([driving], 'I PASSED 😭', {
      now: FRI_11_SEP,
      timeZone: LONDON,
    });
    assert.equal(implicit.action, 'resolve');

    const ambiguous = applyOpenLoopLifecycle(
      [driving, interviewTomorrow()],
      'I PASSED',
      { now: FRI_11_SEP, timeZone: LONDON },
    );
    assert.equal(ambiguous.action, 'none');
    assert.equal(ambiguous.patch, null);
  });

  it('marks a missed date as expired, not resolved', () => {
    const parsed = parseTemporalExpressions('Friday', { now: THU_10_SEP, timeZone: LONDON })!;
    const driving = memory('Driving test', 'My driving test is Friday', {
      occurredAt: parsed.occurredAt,
      expiresAt: parsed.expiresAt,
      tags: [TAG_EXPLICIT, TAG_OPEN_LOOP, ...tagsFromParsedTemporal(parsed)],
    });
    assert.equal(readOpenLoopStatus(driving, SAT_12_SEP), 'expired');
    assert.equal(driving.tags.includes(TAG_RESOLVED), false);
  });
});

describe('Phase 2B topic, isolation, sensitivity, network', () => {
  it('selects the interview on back-to-the-interview', () => {
    const topic = resolveActiveTopic({
      memories: [drivingTomorrow(), interviewTomorrow()],
      userMessage: 'anyway back to the interview',
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(topic.source, 'reference');
    assert.match(topic.label ?? '', /interview/i);
  });

  it('never minds without corrupting event state', () => {
    const driving = drivingTomorrow();
    const result = applyOpenLoopLifecycle([driving], 'actually never mind', {
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(result.action, 'abandon');
    assert.equal(readOpenLoopStatus(driving, THU_10_SEP), 'open');
  });

  it('ignores open loops on factual math', () => {
    const driving = drivingTomorrow();
    const ranked = rankMemories([driving], {
      userMessage: "What's 17x24?",
      mode: 'friend',
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(filterMemoriesForIntent(ranked, 'factual_question', "What's 17x24?", 'skip').length, 0);
    assert.equal(talkIntentSkipsMemoryRetrieval(classifyTalkIntent("What's 17x24?").intent), true);
  });

  it('does not callback a sensitive medical appointment on a casual turn', () => {
    const parsed = parseTemporalExpressions('tomorrow', { now: THU_10_SEP, timeZone: LONDON })!;
    const medical = memory('Health', 'diagnosed last year, appointment tomorrow', {
      category: 'emotional',
      occurredAt: parsed.occurredAt,
      tags: ['sensitive', TAG_EXPLICIT, TAG_OPEN_LOOP, ...tagsFromParsedTemporal(parsed)],
    });
    assert.equal(detectMemorySensitivity(medical.content), 'health');
    const join = joinOpenLoops([medical], {
      userMessage: "I'm tired",
      now: THU_10_SEP,
      timeZone: LONDON,
    });
    assert.equal(join.unique, false);
    assert.equal(
      decideMemoryCallback({
        memory: medical,
        userMessage: "I'm tired",
        intent: 'casual_conversation',
        memoryPolicy: 'high_confidence_only',
        keywordOverlap: 0,
        temporalAlign: false,
        ambiguousTemporalMatch: false,
        uniqueOpenLoop: false,
      }),
      'ignore',
    );
  });

  it('keeps Talk extraction local and matching cheap', async () => {
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

    const driving = drivingTomorrow();
    const started = Date.now();
    for (let i = 0; i < 400; i += 1) {
      joinOpenLoops([driving, interviewTomorrow()], {
        userMessage: "I'm kinda nervous for tomorrow ngl",
        now: THU_10_SEP,
        timeZone: LONDON,
      });
      resolveActiveTopic({
        memories: [driving],
        userMessage: 'back to the interview',
        now: THU_10_SEP,
        timeZone: LONDON,
      });
    }
    assert.ok(Date.now() - started < 10_000);
  });
});
