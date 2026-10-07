import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { AI_GATEWAY_BUDGETS } from '../src/config/ai-gateway-budgets';
import {
  buildBoundedGatewayChatMessages,
  buildUserTurnContent,
  computeGatewayPayloadDiagnostics,
  IMAGE_TURN_VISION_INSTRUCTION,
  logGatewayPayloadDiagnostics,
} from '../src/services/ai/gateway-context-budget';
import { GenerateReplyInput } from '../src/services/contracts';
import { createDefaultCompanionIdentity } from '../src/constants/companion-identity';
import { createDefaultSubscription } from '../src/types/subscription';
import { Message, UserProfile } from '../src/types';
import {
  lastLocalImageUriFromHistory,
  messageRefersToAttachedPhoto,
  resolveImageUrlForVision,
} from '../src/services/ai/vision-follow-up';
import {
  ABUSE_LIMITS,
  textCharsFromContent,
  validateChatPayloadSize,
  validateGatewayMessageContent,
  validateVisionImageDataUrl,
} from '../supabase/functions/_shared/usage-guard.ts';

const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function makeProfile(): UserProfile {
  return {
    id: 'user-1',
    displayName: 'Alex',
    email: 'alex@example.com',
    timezone: 'UTC',
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
    companionIdentity: createDefaultCompanionIdentity(),
    subscription: createDefaultSubscription(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeMessage(index: number, role: Message['role'], content: string): Message {
  return {
    id: `msg-${index}`,
    conversationId: 'conv-1',
    role,
    content,
    mode: 'friend',
    createdAt: `2026-01-01T00:0${index % 10}:00.000Z`,
    status: 'sent',
  };
}

function makeInput(overrides: Partial<GenerateReplyInput> = {}): GenerateReplyInput {
  return {
    userProfile: makeProfile(),
    mode: 'friend',
    userMessage: 'What is in this photo?',
    conversationHistory: [
      makeMessage(0, 'user', 'Earlier text'),
      makeMessage(1, 'voxa', 'Earlier reply'),
    ],
    memories: [],
    ...overrides,
  };
}

describe('gateway vision multimodal', () => {
  it('keeps ordinary text-only Talk payloads as strings', () => {
    const { messages } = buildBoundedGatewayChatMessages(
      makeInput({
        conversationHistory: [],
        imageUrlForVision: undefined,
        userMessage: 'Hello Voxa',
      }),
    );
    const user = [...messages].reverse().find((m) => m.role === 'user');
    assert.equal(typeof user?.content, 'string');
    assert.equal(user?.content, 'Hello Voxa');
    assert.equal(typeof messages[0]?.content, 'string');
  });

  it('converts the current user photo turn into multipart text + image_url', () => {
    const content = buildUserTurnContent(
      makeInput({
        userMessage: 'Describe this',
        imageUrlForVision: TINY_JPEG,
      }),
    );
    assert.ok(Array.isArray(content));
    assert.equal(content[0]?.type, 'text');
    const text = content[0] && content[0].type === 'text' ? content[0].text : '';
    assert.ok(text.startsWith('Describe this'));
    assert.match(text, new RegExp(IMAGE_TURN_VISION_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(text, /If the image is unclear/i);
    assert.doesNotMatch(text, /cannot identify/i);
    assert.doesNotMatch(text, /can't identify/i);
    assert.doesNotMatch(text, /do not claim that you cannot see/i);
    assert.doesNotMatch(text, /\[Photo shared\]/);
    assert.equal(content[1]?.type, 'image_url');
    assert.equal(
      content[1] && content[1].type === 'image_url' ? content[1].image_url.url : '',
      TINY_JPEG,
    );
  });

  it('uses a neutral fallback when the photo has no meaningful user text', () => {
    const content = buildUserTurnContent(
      makeInput({ userMessage: '   ', imageUrlForVision: TINY_JPEG }),
    );
    assert.ok(Array.isArray(content));
    const text = content[0] && content[0].type === 'text' ? content[0].text : '';
    assert.ok(text.startsWith('What do you see in this image?'));
    assert.doesNotMatch(text, /If the image is unclear/i);
  });

  it('does not add the vision-availability instruction to ordinary text-only turns', () => {
    const content = buildUserTurnContent(
      makeInput({
        conversationHistory: [],
        imageUrlForVision: undefined,
        userMessage: 'Just chatting with no photo',
      }),
    );
    assert.equal(typeof content, 'string');
    assert.equal(content, 'Just chatting with no photo');
    assert.ok(!String(content).includes(IMAGE_TURN_VISION_INSTRUCTION));
    assert.ok(!String(content).includes('available for visual inspection'));
    assert.ok(!String(content).includes('## Attached photo'));
  });

  it('keeps system and history text-only while only the current user turn is multimodal', () => {
    const { messages } = buildBoundedGatewayChatMessages(
      makeInput({ imageUrlForVision: TINY_JPEG }),
    );
    const system = messages.find((m) => m.role === 'system');
    const historyAndAssistants = messages.filter((m) => m.role !== 'system');
    const currentUser = historyAndAssistants[historyAndAssistants.length - 1];
    const prior = historyAndAssistants.slice(0, -1);
    assert.equal(typeof system?.content, 'string');
    for (const item of prior) {
      assert.equal(typeof item.content, 'string');
    }
    assert.equal(currentUser?.role, 'user');
    assert.ok(Array.isArray(currentUser?.content));
    assert.match(String(system?.content), /## Attached photo/);
    assert.match(String(system?.content), /Answer from that photo/);
    assert.doesNotMatch(String(system?.content), /cannot see images/i);
    assert.doesNotMatch(String(system?.content), /can't identify/i);
    assert.doesNotMatch(String(system?.content), /cannot identify/i);
    assert.doesNotMatch(String(system?.content), /do not claim that you cannot see/i);
  });

  it('does not count base64 image bytes toward text/context budgets', () => {
    const { messages, diagnostics } = buildBoundedGatewayChatMessages(
      makeInput({
        conversationHistory: [],
        userMessage: 'Photo question',
        imageUrlForVision: TINY_JPEG,
      }),
    );
    const user = [...messages].reverse().find((m) => m.role === 'user');
    assert.ok(user);
    const expectedTextChars = textCharsFromContent([
      {
        type: 'text',
        text: `Photo question\n\n${IMAGE_TURN_VISION_INSTRUCTION}`,
      },
    ]);
    assert.equal(textCharsFromContent(user!.content), expectedTextChars);
    assert.equal(diagnostics.currentUserMessageChars, expectedTextChars);
    assert.ok(diagnostics.totalChars <= AI_GATEWAY_BUDGETS.maxTotalPayloadChars);
    assert.ok(diagnostics.requestBytes > diagnostics.totalChars);
  });

  it('rejects http(s) image URLs', () => {
    const result = validateVisionImageDataUrl('https://example.com/photo.jpg');
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, 'invalid_image');
  });

  it('rejects non-image data URLs', () => {
    const result = validateVisionImageDataUrl('data:text/plain;base64,AAAA');
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, 'invalid_image');
  });

  it('rejects malformed image data URLs', () => {
    assert.equal(validateVisionImageDataUrl('data:image/jpeg;base64,').allowed, false);
    assert.equal(validateVisionImageDataUrl('not-a-data-url').allowed, false);
    assert.equal(validateVisionImageDataUrl('data:image/jpeg;base64,@@@').allowed, false);
  });

  it('rejects oversized vision images', () => {
    let size = Math.ceil((ABUSE_LIMITS.maxVisionImageBytes * 4) / 3) + 16;
    size += (4 - (size % 4)) % 4;
    const huge = `data:image/jpeg;base64,${'A'.repeat(size)}`;
    const result = validateVisionImageDataUrl(huge);
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.code === 'image_too_large' || result.code === 'invalid_image');
      // Prefer size rejection when payload is well-formed base64.
      assert.equal(result.code, 'image_too_large');
    }
  });

  it('rejects multipart image content on system and assistant roles', () => {
    const parts = [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: TINY_JPEG } },
    ];
    assert.equal(validateGatewayMessageContent('system', parts).ok, false);
    assert.equal(validateGatewayMessageContent('assistant', parts).ok, false);
    assert.equal(validateGatewayMessageContent('user', parts).ok, true);
  });

  it('still allows text-only payload size checks', () => {
    const result = validateChatPayloadSize([
      { role: 'system', content: 'You are Voxa.' },
      { role: 'user', content: 'Reply with exactly: gateway-ok' },
    ]);
    assert.deepEqual(result, { allowed: true });
  });

  it('diagnostics logger does not include raw base64 in the feature detail line', () => {
    const { diagnostics } = buildBoundedGatewayChatMessages(
      makeInput({ imageUrlForVision: TINY_JPEG }),
    );
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      const prevDev = (globalThis as { __DEV__?: boolean }).__DEV__;
      (globalThis as { __DEV__?: boolean }).__DEV__ = true;
      logGatewayPayloadDiagnostics(diagnostics);
      (globalThis as { __DEV__?: boolean }).__DEV__ = prevDev;
    } finally {
      console.log = originalLog;
    }
    const joined = logs.join('\n');
    assert.ok(!joined.includes('base64,'));
    assert.ok(!joined.includes('/9j/'));
  });

  it('computeGatewayPayloadDiagnostics text totals ignore image binary', () => {
    const messages = buildBoundedGatewayChatMessages(
      makeInput({ conversationHistory: [], userMessage: 'Hi', imageUrlForVision: TINY_JPEG }),
    ).messages;
    const diagnostics = computeGatewayPayloadDiagnostics(messages, 0);
    const expectedTextChars = `Hi\n\n${IMAGE_TURN_VISION_INSTRUCTION}`.length;
    assert.equal(diagnostics.currentUserMessageChars, expectedTextChars);
    assert.ok(diagnostics.requestBytes > expectedTextChars);
  });
});

describe('vision follow-up after a sent photo', () => {
  it('recognises the physical QA photo question', () => {
    assert.equal(messageRefersToAttachedPhoto('What can you see in this photo?'), true);
    assert.equal(messageRefersToAttachedPhoto('What do u see in this picture'), true);
    assert.equal(messageRefersToAttachedPhoto('How was your day?'), false);
  });

  it('reuses the last local photo URI for a follow-up question and ignores https remotes', () => {
    const history: Message[] = [
      makeMessage(0, 'user', 'Sent an attachment'),
      makeMessage(1, 'voxa', 'Got it'),
    ];
    history[0] = {
      ...history[0],
      attachments: [
        {
          id: 'att-1',
          type: 'image',
          localUri: 'file:///cache/photo.jpg',
          remoteUrl: 'https://example.com/x.jpg',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    assert.equal(lastLocalImageUriFromHistory(history), 'file:///cache/photo.jpg');
    assert.equal(
      resolveImageUrlForVision({
        userMessage: 'What can you see in this photo?',
        history,
      }),
      'file:///cache/photo.jpg',
    );
    assert.equal(
      resolveImageUrlForVision({
        currentTurnUri: 'file:///cache/newer.jpg',
        userMessage: 'What can you see in this photo?',
        history,
      }),
      'file:///cache/newer.jpg',
    );
    assert.equal(
      resolveImageUrlForVision({
        userMessage: 'What should I have for dinner?',
        history,
      }),
      undefined,
    );
  });

  it('wires follow-up vision into sendChatMessage after history is built', () => {
    const companion = readFileSync('src/services/voxa-companion-service.ts', 'utf8');
    assert.match(companion, /resolveImageUrlForVision/);
    const processAt = companion.indexOf('imageUrlForVision = processed.imageUrlForVision');
    const followAt = companion.indexOf('resolveImageUrlForVision({');
    const aiAt = companion.lastIndexOf('imageUrlForVision,');
    assert.ok(processAt > 0 && followAt > processAt && aiAt > followAt);
  });
});

describe('same-turn vision payload', () => {
  it('strips [Photo shared] and keeps one image_url for photo + question', () => {
    const content = buildUserTurnContent(
      makeInput({
        userMessage: 'What do u see in this picture\n[Photo shared]',
        imageUrlForVision: TINY_JPEG,
      }),
    );
    assert.ok(Array.isArray(content));
    const text = content[0] && content[0].type === 'text' ? content[0].text : '';
    assert.match(text, /What do u see in this picture/);
    assert.doesNotMatch(text, /\[Photo shared\]/);
    assert.doesNotMatch(text, /Photo context:/);
    assert.equal(content.filter((part) => part.type === 'image_url').length, 1);
  });

  it('does not inject photo analysis text when the image_url is present', () => {
    const content = buildUserTurnContent(
      makeInput({
        userMessage: 'What can you see in this photo?',
        imageUrlForVision: TINY_JPEG,
        imageAnalysisSummary: 'someone by a pool with a nice view',
      }),
    );
    assert.ok(Array.isArray(content));
    const text = content[0] && content[0].type === 'text' ? content[0].text : '';
    assert.doesNotMatch(text, /pool/);
    assert.doesNotMatch(text, /Photo context:/);
  });

  it('does not add vision system copy to ordinary later text', () => {
    const { messages } = buildBoundedGatewayChatMessages(
      makeInput({
        conversationHistory: [
          makeMessage(0, 'user', 'photo earlier'),
          makeMessage(1, 'voxa', 'Nice photo'),
        ],
        userMessage: 'What should I have for dinner?',
        imageUrlForVision: undefined,
      }),
    );
    const system = messages.find((m) => m.role === 'system');
    const user = [...messages].reverse().find((m) => m.role === 'user');
    assert.equal(typeof user?.content, 'string');
    assert.equal(user?.content, 'What should I have for dinner?');
    assert.doesNotMatch(String(system?.content), /## Attached photo/);
  });
});
