import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActionIntentParser,
  extractRememberedFact,
  formatMemorySavedConfirmation,
} from '../src/services/actions/action-intent-parser';
import { classifyTalkIntent, intentWantsMemories } from '../src/services/ai/companion-intent';
import { selectContextModules } from '../src/services/ai/companion-context-router';
import { resolveImageUrlForVision } from '../src/services/ai/vision-follow-up';
import { talkIntentSkipsMemoryRetrieval } from '../src/services/chat/talk-critical-path';
import {
  beginTalkSend,
  createTalkSendGuard,
  endTalkSend,
} from '../src/services/chat/talk-send-guard';
import { FakeAIService } from '../src/services/ai/fake-ai-service';
import { MemoryIntelligenceService } from '../src/services/memory/memory-intelligence-service';
import { filterMemoriesForIntent, rankMemories } from '../src/services/memory/memory-relevance';
import { TAG_EXPLICIT } from '../src/services/memory/memory-taxonomy';
import { classifyGatewayErrorMessage, TalkAIError } from '../src/services/ai/talk-ai-errors';
import { Memory, Message } from '../src/types';
import { IMemoryRepository } from '../src/services/contracts';

const parser = new ActionIntentParser();

function storedMemory(content: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${content.slice(0, 12)}`,
    userId: 'user-1',
    category: 'preferences',
    title: content.slice(0, 48),
    content,
    mood: 'neutral',
    importance: 4,
    tags: [TAG_EXPLICIT],
    source: 'conversation',
    useCount: 0,
    confidence: 0.9,
    createdAt: '2026-10-07T09:00:00.000Z',
    updatedAt: '2026-10-07T09:00:00.000Z',
    ...overrides,
  };
}

function photoHistory(): Message[] {
  return [
    {
      id: 'u-photo',
      conversationId: 'c1',
      role: 'user',
      content: 'What do you see',
      mode: 'friend',
      createdAt: '2026-10-07T09:00:00.000Z',
      status: 'sent',
      attachments: [
        {
          id: 'a1',
          type: 'image',
          localUri: 'file:///cache/laptop.jpg',
          createdAt: '2026-10-07T09:00:00.000Z',
        },
      ],
    },
    {
      id: 'v-photo',
      conversationId: 'c1',
      role: 'voxa',
      content: 'I can see a laptop. The smaller writing is unreadable.',
      mode: 'friend',
      createdAt: '2026-10-07T09:00:01.000Z',
      status: 'sent',
    },
  ];
}

describe('memory save confirmation and fact extraction', () => {
  it('stores the fact, not a trailing remember-that cue', () => {
    const parsed = parser.parse('My test colour is purple. Remember that.');
    assert.equal(parsed?.action, 'add_memory');
    if (parsed?.action !== 'add_memory') return;
    assert.match(parsed.content, /purple/i);
    assert.doesNotMatch(parsed.content, /^that$/i);
    assert.equal(
      formatMemorySavedConfirmation(parsed.content),
      "Saved — I'll remember that my test colour is purple.",
    );
    assert.doesNotMatch(formatMemorySavedConfirmation(parsed.content), /that that/i);
  });

  it('extracts equivalent remember phrasings without hard-coded test values', () => {
    assert.match(extractRememberedFact('My favourite drink is apple juice. Remember that.') ?? '', /apple juice/i);
    assert.match(extractRememberedFact('Remember that my project codename is Atlas.') ?? '', /Atlas/i);
    assert.equal(extractRememberedFact('Remember that.'), undefined);
    assert.equal(formatMemorySavedConfirmation('that'), "Saved — I'll remember that.");
  });
});

describe('memory recall routing after save', () => {
  it('classifies personal what-is-my questions as memory_recall and retrieves the saved fact', () => {
    const memory = storedMemory('My test colour is purple');
    for (const message of [
      'What is my test colour?',
      'What colour did I tell you?',
      'Do you remember my test colour?',
    ]) {
      const intent = classifyTalkIntent(message).intent;
      assert.equal(intent, 'memory_recall', message);
      assert.equal(talkIntentSkipsMemoryRetrieval(intent), false, message);
      assert.equal(intentWantsMemories(intent), true, message);
      const ranked = rankMemories([memory], { userMessage: message, mode: 'friend' });
      const selected = filterMemoriesForIntent(ranked, intent, message, 'recall');
      assert.equal(selected.length > 0, true, message);
      assert.match(selected[0]?.content ?? '', /purple/i);
    }
  });

  it('does not attach notes/phase8 solely because a personal fact is being recalled', () => {
    const modules = selectContextModules('memory_recall', 'What is my test colour?');
    assert.equal(modules.includes('notes'), false);
    assert.equal(modules.includes('phase8_focused'), false);
  });

  it('does not reuse a previous photo on a memory question', () => {
    assert.equal(
      resolveImageUrlForVision({
        userMessage: 'What is my test colour?',
        history: photoHistory(),
      }),
      undefined,
    );
  });
});

describe('memory retrieval survives update failures', () => {
  it('still returns ranked memories when lastUsedAt persistence throws', async () => {
    const memory = storedMemory('My favourite drink is apple juice');
    const repo: IMemoryRepository = {
      listMemories: async () => [memory],
      getMemory: async () => memory,
      createMemory: async () => memory,
      updateMemory: async () => {
        throw new Error('Memory not found: remote-only id');
      },
      deleteMemory: async () => undefined,
      clearMemoriesForUser: async () => undefined,
    };
    const engine = new MemoryIntelligenceService(repo, new FakeAIService());
    const selected = await engine.retrieveForPrompt('user-1', {
      userMessage: 'What is my favourite drink?',
      mode: 'friend',
    }, { intent: 'memory_recall' });
    assert.equal(selected.length > 0, true);
    assert.match(selected[0]?.content ?? '', /apple juice/i);
  });
});

describe('retry after memory-recall send failure', () => {
  it('allows an immediate retry of the same text after the lock is released', () => {
    const guard = createTalkSendGuard();
    assert.equal(
      beginTalkSend(guard, { text: 'What is my test colour?', conversationId: 'c1', now: 1_000 }).accepted,
      true,
    );
    endTalkSend(guard);
    const blocked = beginTalkSend(guard, {
      text: 'What is my test colour?',
      conversationId: 'c1',
      now: 1_100,
    });
    assert.equal(blocked.accepted, false);
    if (!blocked.accepted) assert.equal(blocked.reason, 'duplicate_submit');

    const retry = beginTalkSend(guard, {
      text: 'What is my test colour?',
      conversationId: 'c1',
      now: 1_100,
      isRetry: true,
    });
    assert.equal(retry.accepted, true);
    endTalkSend(guard);
    assert.equal(guard.inFlight, false);
    const nextOrdinary = beginTalkSend(guard, {
      text: 'Explain a Python function in simple terms.',
      conversationId: 'c1',
      now: 1_400,
    });
    assert.equal(nextOrdinary.accepted, true);
  });

  it('does not classify a memory-recall failure as a usage limit', () => {
    assert.equal(classifyGatewayErrorMessage('Invalid chat request', 'invalid_request'), 'gateway_error');
    assert.equal(new TalkAIError('usage_limited').userMessage.includes("today's chat limit"), true);
    assert.doesNotMatch(new TalkAIError('gateway_error').userMessage, /today's chat limit/i);
  });
});
