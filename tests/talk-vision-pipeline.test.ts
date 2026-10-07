import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { TalkAIError } from '../src/services/ai/talk-ai-errors';
import {
  buildVisionDataUrl,
  mimeTypeFromUri,
  normalizeVisionDataUrl,
} from '../src/services/ai/vision-data-url';
import {
  lastLocalImageUriFromHistory,
  messageRefersToAttachedPhoto,
  resolveImageUrlForVision,
  stripVisionPlaceholdersFromUserText,
} from '../src/services/ai/vision-follow-up';
import { durableChatImageFileName } from '../src/services/attachments/prepare-chat-image-plan';
import { pendingAttachmentPreviewLabel } from '../src/services/chat/pending-attachment-preview';
import { shouldRestorePendingAttachments } from '../src/services/chat/pending-attachment-send';
import { Message } from '../src/types';

function photoHistory(localUri: string): Message[] {
  return [
    {
      id: 'msg-0',
      conversationId: 'conv-1',
      role: 'user',
      content: 'Sent an attachment',
      mode: 'friend',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'sent',
      attachments: [
        {
          id: 'att-1',
          type: 'image',
          localUri,
          fileName: '0db6957b-1abc-4def-8901-23456789abcd.jpg',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'voxa',
      content: 'Got it',
      mode: 'friend',
      createdAt: '2026-01-01T00:01:00.000Z',
      status: 'sent',
    },
  ];
}

describe('same-turn and follow-up vision pipeline', () => {
  it('A. same-turn photo + text keeps the local URI for vision', () => {
    const processor = readFileSync('src/services/attachments/attachment-processor.ts', 'utf8');
    assert.match(processor, /imageUrlForVision = item\.localUri/);
    assert.match(processor, /\[Photo shared\]/);
    const localUri = 'file:///cache/voxa-chat-1.jpg';
    const effective = `What do u see in this picture\n[Photo shared]`;
    assert.equal(stripVisionPlaceholdersFromUserText(effective), 'What do u see in this picture');
    assert.equal(
      resolveImageUrlForVision({
        currentTurnUri: localUri,
        userMessage: effective,
        history: [],
      }),
      localUri,
    );
  });

  it('B. photo then what-can-you-see reuses the last local URI', () => {
    const history = photoHistory('file:///cache/voxa-chat-1.jpg');
    assert.equal(lastLocalImageUriFromHistory(history), 'file:///cache/voxa-chat-1.jpg');
    assert.equal(
      resolveImageUrlForVision({
        userMessage: 'What can you see in this photo?',
        history,
      }),
      'file:///cache/voxa-chat-1.jpg',
    );
  });

  it('C. screenshot + question counts as a photo question', () => {
    assert.equal(messageRefersToAttachedPhoto('What do you see in this screenshot picture?'), true);
    assert.equal(messageRefersToAttachedPhoto('describe this image'), true);
  });

  it('D. camera and library both prepare then attach', () => {
    const input = readFileSync('src/components/chat/chat-input-bar.tsx', 'utf8');
    assert.match(input, /launchCameraAsync/);
    assert.match(input, /launchImageLibraryAsync/);
    assert.match(input, /attachPreparedImage\(result\.assets\[0\]\)/);
    const cameraAt = input.indexOf('launchCameraAsync');
    const libraryAt = input.indexOf('launchImageLibraryAsync');
    const attachFnAt = input.indexOf('const attachPreparedImage');
    assert.ok(attachFnAt > 0 && cameraAt > attachFnAt && libraryAt > attachFnAt);
  });

  it('E. ordinary later text does not resend the previous image', () => {
    const history = photoHistory('file:///cache/voxa-chat-1.jpg');
    for (const message of [
      'What should I have for dinner?',
      'What is my test colour',
      "What's the latest Apple news?",
    ]) {
      assert.equal(
        resolveImageUrlForVision({ userMessage: message, history }),
        undefined,
        message,
      );
    }
  });

  it('F. empty local reads fail closed instead of sending a fake vision reply', () => {
    assert.throws(() => buildVisionDataUrl(''), TalkAIError);
    assert.throws(() => buildVisionDataUrl('   \n  '), TalkAIError);
    const err = new TalkAIError('image_too_large');
    assert.match(err.userMessage, /couldn't process that photo/i);
    assert.doesNotMatch(err.userMessage, /file:\/\//);
    assert.doesNotMatch(err.userMessage, /base64/);
  });

  it('G. cancelled picker does not add an attachment', () => {
    const input = readFileSync('src/components/chat/chat-input-bar.tsx', 'utf8');
    assert.match(input, /result\.canceled \|\| !result\.assets\[0\]/);
    assert.doesNotMatch(input, /addAttachment\([\s\S]{0,40}canceled/);
  });

  it('H. compression path still steps JPEG quality and copies to a durable .jpg', () => {
    const plan = readFileSync('src/services/attachments/prepare-chat-image-plan.ts', 'utf8');
    assert.match(plan, /CHAT_IMAGE_QUALITY_STEPS/);
    assert.match(plan, /durableChatImageFileName/);
    const prepare = readFileSync('src/services/attachments/prepare-chat-image.ts', 'utf8');
    assert.match(prepare, /persistPreparedChatJpeg/);
    assert.match(prepare, /SaveFormat\.JPEG/);
    assert.equal(durableChatImageFileName(1700000000000), 'voxa-chat-1700000000000.jpg');
  });

  it('I. MIME and data URL construction compact whitespace and default to jpeg', () => {
    assert.equal(mimeTypeFromUri('file:///cache/voxa-chat-1.jpg'), 'image/jpeg');
    assert.equal(mimeTypeFromUri('file:///cache/photo.PNG'), 'image/png');
    const wrapped = 'data:image/jpeg;base64,/9j/\n4AAQ';
    assert.equal(normalizeVisionDataUrl(wrapped), 'data:image/jpeg;base64,/9j/4AAQ');
    assert.equal(buildVisionDataUrl('/9j/4AAQ', 'image/jpeg'), 'data:image/jpeg;base64,/9j/4AAQ');
  });

  it('J/K/L. one user send uses one AI generate path', () => {
    const companion = readFileSync('src/services/voxa-companion-service.ts', 'utf8');
    const sendStart = companion.indexOf('async sendChatMessage');
    const sendBody = companion.slice(sendStart, companion.indexOf('\n  async ', sendStart + 10));
    const generateCalls = sendBody.match(/this\.ai\.generateReply(Stream)?\(/g) ?? [];
    assert.equal(generateCalls.length, 2);
    assert.match(sendBody, /if \(publishChunk && isStreamCapableAI/);
    assert.match(sendBody, /imageUrlForVision = processed\.imageUrlForVision/);
    assert.match(sendBody, /stripVisionPlaceholdersFromUserText\(effectiveUserText\)/);
  });

  it('M. attachments stay on the send snapshot until consumed', () => {
    const input = readFileSync('src/components/chat/chat-input-bar.tsx', 'utf8');
    assert.match(input, /const snapshot = pendingAttachments/);
    assert.match(input, /onSend\(snapshot\)/);
    assert.equal(shouldRestorePendingAttachments(false), true);
    assert.equal(shouldRestorePendingAttachments(true), false);
  });

  it('N. follow-up dinner questions do not reuse the image', () => {
    assert.equal(
      resolveImageUrlForVision({
        currentTurnUri: undefined,
        userMessage: 'What should I have for dinner?',
        history: photoHistory('file:///cache/voxa-chat-1.jpg'),
      }),
      undefined,
    );
  });

  it('O. failed image preparation never invents analysis text and prompts do not declare vision unavailable', () => {
    const input = readFileSync('src/components/chat/chat-input-bar.tsx', 'utf8');
    assert.match(input, /That photo could not be prepared/);
    assert.doesNotMatch(input, /someone by a pool/);
    const processor = readFileSync('src/services/attachments/attachment-processor.ts', 'utf8');
    assert.match(processor, /analysisSummary: 'Photo shared'/);
    assert.doesNotMatch(processor, /I can't see images/);
    const prompt = readFileSync('src/services/ai/voxa-system-prompt.ts', 'utf8');
    assert.doesNotMatch(prompt, /cannot see images/i);
    assert.doesNotMatch(prompt, /can't identify/i);
    const budget = readFileSync('src/services/ai/gateway-context-budget.ts', 'utf8');
    assert.doesNotMatch(budget, /If the image is unclear/);
  });
});

describe('pending attachment presentation', () => {
  it('shows Photo instead of a UUID or cache file name', () => {
    assert.equal(
      pendingAttachmentPreviewLabel({
        type: 'image',
        localUri: 'file:///cache/voxa-chat-1.jpg',
        fileName: '0db6957b-1abc-4def-8901-23456789abcd.jpg',
      }),
      'Photo',
    );
    const tray = readFileSync('src/components/chat/attachment-preview-tray.tsx', 'utf8');
    assert.match(tray, /pendingAttachmentPreviewLabel/);
    assert.doesNotMatch(tray, /item\.fileName \?\? item\.type/);
  });
});
