import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyTalkIntent, intentWantsMemories } from '../src/services/ai/companion-intent';
import { resolveImageUrlForVision } from '../src/services/ai/vision-follow-up';
import { resolveLiveInformationPlan } from '../src/services/ai/live-information';
import { resolveRelativeDateWindow } from '../src/services/ai/relative-calendar';
import { talkIntentSkipsMemoryRetrieval } from '../src/services/chat/talk-critical-path';
import {
  sanitizeTalkDisplayText,
  talkDisplayContainsRawWebNoise,
} from '../src/services/chat/sanitize-talk-display';
import {
  formatStraightLineDistance,
  formatVerifiedDistanceReply,
  haversineKilometres,
  normalizeUkPostcode,
  parseDistanceQuestion,
} from '../src/services/location/postcode-distance';
import { Message } from '../src/types';

const photoHistory: Message[] = [
  {
    id: 'u1',
    conversationId: 'c1',
    role: 'user',
    content: 'What do u see',
    mode: 'friend',
    createdAt: '2026-10-07T09:00:00.000Z',
    status: 'sent',
    attachments: [
      {
        id: 'a1',
        type: 'image',
        localUri: 'file:///cache/voxa-chat-1.jpg',
        createdAt: '2026-10-07T09:00:00.000Z',
      },
    ],
  },
];

describe('release-blocker routing after images', () => {
  it('recalls personal facts instead of treating them as vision or math', () => {
    for (const message of [
      'What is my test colour',
      'What colour did I tell you?',
      'Do you remember my test colour?',
    ]) {
      const intent = classifyTalkIntent(message).intent;
      assert.equal(intent, 'memory_recall', message);
      assert.equal(talkIntentSkipsMemoryRetrieval(intent), false, message);
      assert.equal(intentWantsMemories(intent), true, message);
      assert.equal(
        resolveImageUrlForVision({ userMessage: message, history: photoHistory }),
        undefined,
        message,
      );
    }
  });

  it('does not search the web for evergreen explanations', () => {
    for (const message of [
      'Explain a Python function in simple terms.',
      "What's a variable?",
      'Help me plan my afternoon.',
      'Give me motivation to revise.',
    ]) {
      assert.equal(resolveLiveInformationPlan({ userMessage: message }).liveSearch, false, message);
    }
  });

  it('keeps current-information questions on live search', () => {
    for (const message of [
      "What's the latest Apple news?",
      "Who's top of the Premier League?",
      'What fights are happening this weekend?',
    ]) {
      assert.equal(resolveLiveInformationPlan({ userMessage: message }).liveSearch, true, message);
    }
  });
});

describe('release-blocker distance and postcodes', () => {
  it('normalizes UK postcodes with and without spaces or case', () => {
    assert.equal(normalizeUkPostcode('SE6 1QE'), 'SE6 1QE');
    assert.equal(normalizeUkPostcode('se61qe'), 'SE6 1QE');
    assert.equal(normalizeUkPostcode('SE6 1UA'), 'SE6 1UA');
    assert.equal(normalizeUkPostcode('se61ua'), 'SE6 1UA');
  });

  it('parses how-far questions and never invents walking time', () => {
    const parsed = parseDistanceQuestion('How far is SE6 1QE from SE6 1UA?');
    assert.ok(parsed);
    const km = haversineKilometres(
      { latitude: 51.44, longitude: 0.02 },
      { latitude: 51.441, longitude: 0.021 },
    );
    const reply = formatVerifiedDistanceReply({
      ok: true,
      fromLabel: 'SE6 1QE',
      toLabel: 'SE6 1UA',
      kilometres: km,
    });
    assert.match(reply, /straight line/i);
    assert.doesNotMatch(reply, /minute walk/i);
    assert.doesNotMatch(reply, /drive/i);
    assert.match(formatStraightLineDistance(0.4), /metres|km/);
  });
});

describe('release-blocker live presentation', () => {
  it('strips markdown links, openai utm params, and US zone dumps for UK users', () => {
    const raw =
      'Arsenal vs Leeds, Saturday 15:00 BST (07:00 PDT)\n([boxingonly.net](https://www.boxingonly.net/card?utm_source=openai))';
    const clean = sanitizeTalkDisplayText(raw, { timeZone: 'Europe/London' });
    assert.equal(talkDisplayContainsRawWebNoise(clean), false);
    assert.doesNotMatch(clean, /PDT/);
    assert.doesNotMatch(clean, /utm_source/);
    assert.match(clean, /Arsenal vs Leeds/);
  });

  it('keeps this weekend on Saturday and Sunday from a Wednesday', () => {
    const window = resolveRelativeDateWindow(new Date('2026-10-07T12:00:00.000Z'), 'Europe/London');
    assert.match(window.thisWeekend.start, /Saturday.*10.*October.*2026/i);
    assert.match(window.thisWeekend.end, /Sunday.*11.*October.*2026/i);
    assert.doesNotMatch(`${window.thisWeekend.start} ${window.thisWeekend.end}`, /Thursday/);
  });
});
