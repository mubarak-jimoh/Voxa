import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDefaultCompanionIdentity } from '../src/constants/companion-identity';
import {
  applyAttachedPhotoTurnAuthority,
  ATTACHED_PHOTO_GUIDANCE,
  buildVoxaSystemPrompt,
} from '../src/services/ai/voxa-system-prompt';
import {
  buildBoundedGatewayChatMessages,
  buildUserTurnContent,
  IMAGE_TURN_VISION_INSTRUCTION,
} from '../src/services/ai/gateway-context-budget';
import { TURN_INTELLIGENCE_END, TURN_INTELLIGENCE_HEADING } from '../src/services/ai/turn-intelligence-plan';
import { TalkAIError, formatTalkErrorForUser } from '../src/services/ai/talk-ai-errors';
import { resolveImageUrlForVision } from '../src/services/ai/vision-follow-up';
import { GenerateReplyInput } from '../src/services/contracts';
import { createDefaultSubscription } from '../src/types/subscription';
import { Message, UserProfile } from '../src/types';

const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function profile(): UserProfile {
  return {
    id: 'user-1',
    displayName: 'Alex',
    timezone: 'Europe/London',
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

function makeInput(overrides: Partial<GenerateReplyInput> = {}): GenerateReplyInput {
  return {
    userProfile: profile(),
    mode: 'friend',
    userMessage: 'What do you see?',
    conversationHistory: [],
    memories: [],
    turnIntelligenceBlock: [
      TURN_INTELLIGENCE_HEADING,
      'Memory: skip.',
      TURN_INTELLIGENCE_END,
    ].join('\n'),
    ...overrides,
  };
}

const photoHistory: Message[] = [
  {
    id: 'u1',
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
        localUri: 'file:///cache/voxa-chat-1.jpg',
        createdAt: '2026-10-07T09:00:00.000Z',
      },
    ],
  },
];

function assertNoHedgePriming(text: string) {
  assert.doesNotMatch(text, /cannot see images/i);
  assert.doesNotMatch(text, /can't identify/i);
  assert.doesNotMatch(text, /cannot identify/i);
  assert.doesNotMatch(text, /do not claim that you cannot see/i);
  assert.doesNotMatch(text, /If the image is unclear/i);
}

describe('vision response guidance', () => {
  it('1. clear object photo: system + user turn tell the model to describe visible objects', () => {
    const { messages } = buildBoundedGatewayChatMessages(
      makeInput({ userMessage: 'What car is this?', imageUrlForVision: TINY_JPEG }),
    );
    const system = String(messages.find((item) => item.role === 'system')?.content);
    assert.match(system, /You can see it/);
    assert.match(system, /Describe visible objects/);
    assert.match(system, /Photo on this turn: you can see it/);
    assert.ok(system.indexOf('Photo on this turn') < system.indexOf(TURN_INTELLIGENCE_END));
    assertNoHedgePriming(system);
    assertNoHedgePriming(ATTACHED_PHOTO_GUIDANCE);

    const user = messages[messages.length - 1];
    assert.ok(Array.isArray(user.content));
    const text = user.content[0] && user.content[0].type === 'text' ? user.content[0].text : '';
    assert.match(text, /What car is this/);
    assert.match(text, new RegExp(IMAGE_TURN_VISION_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('2. screenshot/laptop-screen photo: prompt covers on-screen writing without denying the photo', () => {
    const content = buildUserTurnContent(
      makeInput({ userMessage: 'What is on my laptop?', imageUrlForVision: TINY_JPEG }),
    );
    assert.ok(Array.isArray(content));
    const text = content[0] && content[0].type === 'text' ? content[0].text : '';
    assert.match(text, /on-screen writing is too small to read/);
    assert.match(text, /after describing the rest of the scene/);
    assertNoHedgePriming(text);
    assert.match(ATTACHED_PHOTO_GUIDANCE, /on-screen writing/);
  });

  it('3. small/unreadable text: guidance says name the unread part, not invent words', () => {
    assert.match(ATTACHED_PHOTO_GUIDANCE, /smaller writing is unreadable/);
    assert.match(ATTACHED_PHOTO_GUIDANCE, /Do not invent the unread words/);
    const injected = applyAttachedPhotoTurnAuthority(
      `${TURN_INTELLIGENCE_HEADING}\n${TURN_INTELLIGENCE_END}`,
      true,
    );
    assert.match(injected, /Unreadable writing is not a missing photo/);
  });

  it('4. person in photo: describe scene and clothing, do not guess a name', () => {
    const prompt = buildVoxaSystemPrompt({
      userProfile: profile(),
      mode: 'friend',
      memories: [],
      hasAttachedImage: true,
      userMessage: 'Who is this?',
    });
    assert.match(prompt, /If a person appears, describe the visible scene and clothing/);
    assert.match(prompt, /Do not guess their name/);
    assert.match(prompt, /Do not guess a person's name/);
    assertNoHedgePriming(prompt);
  });

  it('5. genuine image-processing failure uses the scoped photo error', () => {
    const message = formatTalkErrorForUser(new TalkAIError('image_too_large'));
    assert.equal(message, "I couldn't process that photo. Please try attaching it again.");
    assert.doesNotMatch(message, /can't see/i);
  });

  it('6. later plain text does not reuse vision after an image turn', () => {
    assert.equal(
      resolveImageUrlForVision({
        userMessage: 'What is my test colour',
        history: photoHistory,
      }),
      undefined,
    );
    const textOnly = buildBoundedGatewayChatMessages(
      makeInput({ userMessage: 'What is my test colour', imageUrlForVision: undefined }),
    );
    const system = String(textOnly.messages.find((item) => item.role === 'system')?.content);
    assert.match(system, /This turn has no attached photo/);
    assert.doesNotMatch(system, /Photo on this turn: you can see it/);
    const user = textOnly.messages[textOnly.messages.length - 1];
    assert.equal(typeof user.content, 'string');
    assert.ok(!String(user.content).includes(IMAGE_TURN_VISION_INSTRUCTION));
  });
});
