import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ActionIntentParser } from '../src/services/actions/action-intent-parser';
import {
  isTalkListNearBottom,
  nextTalkJumpToLatestVisible,
  shouldPinTalkToLatest,
} from '../src/services/chat/talk-list-pin';
import {
  beginTalkSend,
  createTalkSendGuard,
  endTalkSend,
  isBurstRateLimitActive,
  isStaleTalkRateLimitBanner,
  noteBurstRateLimit,
  resetTalkSendGuard,
  recoverTimedOutTalkSend,
  TALK_BURST_RATE_LIMIT_COOLDOWN_MS,
  TALK_SEND_TIMEOUT_MS,
} from '../src/services/chat/talk-send-guard';
import { classifyGatewayErrorMessage, TalkAIError } from '../src/services/ai/talk-ai-errors';
import { reminderScheduleConfirmation } from '../src/services/notifications/reminder-schedule-copy';
import { CHALLENGE_TEMPLATES } from '../src/services/phase12/companion-challenge-v2-service';
import { FetchTimeoutError } from '../src/utils/fetch-with-timeout';
import { resolveRelativeReminderDelayMs } from '../src/services/actions/relative-reminder-time';
import { hasAudioPlaybackCompleted, hasAudioPlaybackStarted } from '../src/services/voice/audio-playback-complete';
import { notesListEmptyCopy } from '../src/services/notes/notes-empty-copy';
import { canvasChevronName, canvasSectionsForDisplay } from '../src/components/phase4/conversation-canvas-display';
import { shouldRestorePendingAttachments } from '../src/services/chat/pending-attachment-send';
import { PhotoMemoryService } from '../src/services/phase12/photo-memory-service';
import type { IStorageService } from '../src/services/contracts';

describe('v1 release blocker — talk send recovery', () => {
  it('recovers a timed-out in-flight send so Talk is not permanently locked', () => {
    const guard = createTalkSendGuard();
    assert.equal(beginTalkSend(guard, { text: 'hello', conversationId: 'c1', now: 1_000 }).accepted, true);
    assert.equal(recoverTimedOutTalkSend(guard, 1_000 + TALK_SEND_TIMEOUT_MS - 1), false);
    assert.equal(recoverTimedOutTalkSend(guard, 1_000 + TALK_SEND_TIMEOUT_MS), true);
    assert.equal(guard.inFlight, false);
    assert.equal(beginTalkSend(guard, { text: 'next', conversationId: 'c1', now: 1_000 + TALK_SEND_TIMEOUT_MS + 10 }).accepted, true);
  });

  it('expires burst rate-limit cooldown and stale banners', () => {
    const guard = createTalkSendGuard();
    noteBurstRateLimit(guard, 5_000);
    assert.equal(isBurstRateLimitActive(guard, 5_000 + 1_000), true);
    const blocked = beginTalkSend(guard, { text: 'again', conversationId: 'c1', now: 5_000 + 1_000 });
    assert.equal(blocked.accepted, false);
    if (!blocked.accepted) assert.equal(blocked.reason, 'burst_cooldown');
    assert.equal(isBurstRateLimitActive(guard, 5_000 + TALK_BURST_RATE_LIMIT_COOLDOWN_MS), false);
    assert.equal(
      beginTalkSend(guard, { text: 'later', conversationId: 'c1', now: 5_000 + TALK_BURST_RATE_LIMIT_COOLDOWN_MS }).accepted,
      true,
    );
    endTalkSend(guard);
    assert.equal(
      isStaleTalkRateLimitBanner({ code: 'rate_limited', shownAt: 1_000, now: 1_000 + TALK_BURST_RATE_LIMIT_COOLDOWN_MS }),
      true,
    );
    assert.equal(
      isStaleTalkRateLimitBanner({ code: 'usage_limited', shownAt: 1_000, now: 1_000 + TALK_BURST_RATE_LIMIT_COOLDOWN_MS }),
      false,
    );
  });

  it('maps durable usage limits separately from burst rate limits and timeouts', () => {
    assert.equal(classifyGatewayErrorMessage('x', 'daily_limit'), 'usage_limited');
    assert.equal(new TalkAIError('rate_limited').userMessage.includes('quickly'), true);
    assert.equal(new TalkAIError('usage_limited').userMessage.includes("today's chat limit"), true);
    assert.equal(classifyGatewayErrorMessage(new FetchTimeoutError().message), 'request_timeout');
  });

  it('retries a failed user turn without deleting it first', () => {
    const chat = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(chat, /retryMessage: message/);
    assert.doesNotMatch(chat, /filter\(\(m\) => m\.id !== message\.id\)[\s\S]{0,80}sendMessage/);
    assert.match(chat, /existingUserMessage/);
    assert.match(chat, /status: 'failed'/);
    assert.match(chat, /loadError && messages\.length === 0/);
    assert.match(chat, /AppState\.addEventListener/);
    assert.match(chat, /recoverTimedOutTalkSend/);
    const gateway = readFileSync('src/services/ai/ai-gateway-client.ts', 'utf8');
    assert.match(gateway, /fetchWithTimeout/);
  });
});

describe('v1 release blocker — TTS lifecycle', () => {
  it('stops speech on background and does not alert unless playback was attempted while active', () => {
    const chat = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(chat, /speechAlertAllowedRef/);
    assert.match(chat, /appActiveRef/);
    assert.match(chat, /stopCompanionSpeech/);
    assert.match(chat, /subscribeSpeechOwner/);
    const ttsClient = readFileSync('src/services/voice/tts-gateway-client.ts', 'utf8');
    assert.match(ttsClient, /fetchWithTimeout/);
  });
});

describe('v1 release blocker — talk scroll', () => {
  it('pins to latest on load/send but not while reading history', () => {
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: true, reason: 'load' }), true);
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: true, reason: 'send' }), true);
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: true, reason: 'reply' }), false);
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: false, reason: 'reply' }), true);
    assert.equal(shouldPinTalkToLatest({ userReadingHistory: true, reason: 'typing' }), false);
  });

  it('shows the jump-to-latest control only after scrolling well above the latest messages', () => {
    const atBottom = { contentOffsetY: 900, contentHeight: 1000, layoutHeight: 100 };
    assert.equal(isTalkListNearBottom(atBottom), true);
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: false, ...atBottom }), false);

    const slightlyUp = { contentOffsetY: 780, contentHeight: 1000, layoutHeight: 100 };
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: false, ...slightlyUp }), false);
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: true, ...slightlyUp }), true);

    const wellUp = { contentOffsetY: 700, contentHeight: 1000, layoutHeight: 100 };
    assert.equal(nextTalkJumpToLatestVisible({ currentlyVisible: false, ...wellUp }), true);

    const chat = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(chat, /TalkJumpToLatestButton/);
    assert.match(chat, /userReadingHistoryRef\.current/);
  });
});

describe('v1 release blocker — challenges and spin', () => {
  it('wires challenge templates to start()', () => {
    const screen = readFileSync('src/screens/companion-challenges-screen.tsx', 'utf8');
    assert.match(screen, /onPress=\{\(\) => void start\(t\.id\)\}/);
    assert.ok(CHALLENGE_TEMPLATES.some((item) => item.title === '7-Day Reset'));
    assert.match(screen, /svc\.pause/);
    assert.match(screen, /svc\.resume/);
  });

  it('routes spin to DailySpin and games to GamesHub separately', () => {
    const home = readFileSync('src/screens/home-screen.tsx', 'utf8');
    const spinAt = home.indexOf("a.primaryAction === 'spin'");
    const gamesGate = home.indexOf("isFeatureVisible('socialGames')");
    const dailySpin = home.indexOf("navigate('DailySpin')");
    const gamesHub = home.indexOf("navigate('GamesHub')");
    assert.ok(spinAt > 0 && dailySpin > spinAt);
    assert.ok(dailySpin > 0 && gamesHub > 0);
    const primaryBlock = home.slice(home.indexOf('onPrimary={() => {'), home.indexOf('onChallengeDetails'));
    assert.match(primaryBlock, /DailySpin/);
    assert.ok(primaryBlock.indexOf("primaryAction === 'spin'") < primaryBlock.indexOf("isFeatureVisible('socialGames')"));
    assert.equal(gamesGate > 0, true);
  });
});

describe('v1 release blocker — reminders', () => {
  it('parses remind-me-at-time-to-title and in-N-minutes', () => {
    const parser = new ActionIntentParser();
    const atEight = parser.parse('Remind me at 8pm to revise Python');
    assert.equal(atEight?.action, 'set_reminder');
    if (atEight?.action === 'set_reminder') {
      assert.match(atEight.title, /revise python/i);
      assert.equal(atEight.scheduledAt.getHours(), 20);
    }
    const aMinute = parser.parse('Remind me in a minute to revise python');
    assert.equal(aMinute?.action, 'set_reminder');
    if (aMinute?.action === 'set_reminder') {
      assert.match(aMinute.title, /revise python/i);
      const delta = aMinute.scheduledAt.getTime() - Date.now();
      assert.ok(delta > 30_000 && delta < 90_000);
    }
    const soon = parser.parse('Remind me in 2 minutes to revise Python');
    assert.equal(soon?.action, 'set_reminder');
    if (soon?.action === 'set_reminder') {
      assert.match(soon.title, /revise python/i);
      const delta = soon.scheduledAt.getTime() - Date.now();
      assert.ok(delta > 60_000 && delta < 3 * 60_000);
    }
    const caps = parser.parse('REMIND ME AT 8PM TO REVISE PYTHON');
    assert.equal(caps?.action, 'set_reminder');
    const companion = readFileSync('src/services/voxa-companion-service.ts', 'utf8');
    const parseAt = companion.indexOf('this.chatActions.parseMessage');
    const aiAt = companion.indexOf('this.ai.generateReply', parseAt);
    assert.ok(parseAt > 0 && aiAt > parseAt);
  });

  it('does not claim a notification was scheduled unless it was', () => {
    const ok = reminderScheduleConfirmation({
      title: 'Revise Python',
      when: '8:00 PM',
      scheduled: { ok: true, notificationId: 'n1' },
    });
    assert.equal(ok.success, true);
    assert.match(ok.confirmationMessage, /I'll remind you/i);

    const denied = reminderScheduleConfirmation({
      title: 'Revise Python',
      when: '8:00 PM',
      scheduled: { ok: false, reason: 'permission_denied' },
    });
    assert.equal(denied.success, false);
    assert.doesNotMatch(denied.confirmationMessage, /I'll remind you/i);
    assert.match(denied.confirmationMessage, /notifications are off/i);

    const executor = readFileSync('src/services/actions/chat-action-executor.ts', 'utf8');
    assert.match(executor, /scheduleLocalReminderIfAllowed/);
    assert.doesNotMatch(executor, /scheduleAlarm/);
  });

  it('resolves relative reminder delays including a minute and casing variants', () => {
    const minute = resolveRelativeReminderDelayMs('Remind me in a minute to revise python');
    assert.equal(minute, 60_000);
    assert.equal(resolveRelativeReminderDelayMs('remind me in 2 minutes to revise Python'), 120_000);
    assert.equal(resolveRelativeReminderDelayMs('REMIND ME IN AN HOUR.'), 3_600_000);
    assert.equal(resolveRelativeReminderDelayMs('Remind me at 8pm to revise Python'), null);
  });
});

describe('v1 release blocker — TTS completion signals', () => {
  it('treats didJustFinish and ended currentTime as completed once playback has started', () => {
    assert.equal(hasAudioPlaybackStarted({ currentTime: 0, duration: 2, playing: true }), true);
    assert.equal(
      hasAudioPlaybackCompleted({ didJustFinish: true, currentTime: 0.01, duration: 1.2, playing: false }, true),
      true,
    );
    assert.equal(
      hasAudioPlaybackCompleted(
        { didJustFinish: false, currentTime: 1.19, duration: 1.2, playing: false },
        true,
      ),
      true,
    );
    assert.equal(
      hasAudioPlaybackCompleted({ didJustFinish: false, currentTime: 0, duration: 1.2, playing: false }, true),
      false,
    );
    assert.equal(
      hasAudioPlaybackCompleted({ didJustFinish: true, currentTime: 0.01, duration: 1.2, playing: false }, false),
      false,
    );
  });
});

describe('v1 release blocker — home boot layout and account isolation', () => {
  it('uses one BootLoadingScreen copy for auth restore, companion init, and first Home paint', () => {
    const boot = readFileSync('src/components/ui/boot-loading-screen.tsx', 'utf8');
    const app = readFileSync('App.tsx', 'utf8');
    const home = readFileSync('src/screens/home-screen.tsx', 'utf8');
    const ctx = readFileSync('src/context/voxa-context.tsx', 'utf8');
    assert.match(boot, /Waking up Voxa/);
    assert.doesNotMatch(boot, /Syncing your companion/);
    assert.match(app, /<BootLoadingScreen \/>/);
    assert.doesNotMatch(app, /Syncing your companion/);
    assert.match(home, /<BootLoadingScreen \/>/);
    assert.match(ctx, /presentedUiRef/);
  });

  it('clears talk send guard and does not inherit burst banners across accounts', () => {
    const guard = createTalkSendGuard();
    assert.equal(beginTalkSend(guard, { text: 'hello', conversationId: 'c1', now: 1_000 }).accepted, true);
    noteBurstRateLimit(guard, 2_000);
    resetTalkSendGuard(guard);
    assert.equal(guard.inFlight, false);
    assert.equal(guard.burstCooldownUntil, 0);
    assert.equal(isBurstRateLimitActive(guard, 3_000), false);
    assert.equal(
      isStaleTalkRateLimitBanner({ code: 'rate_limited', shownAt: 1, now: 1 + TALK_BURST_RATE_LIMIT_COOLDOWN_MS }),
      true,
    );
    const chat = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(chat, /resetTalkSendGuard/);
    const session = readFileSync('src/services/session/reset-transient-session-state.ts', 'utf8');
    assert.match(session, /stopAllSpeech/);
    assert.match(session, /invalidateDashboardCache/);
  });

  it('saves Talk photos into the existing Photo Memories store as well as Journey', () => {
    const chat = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(chat, /getPhotoMemoryService/);
    assert.match(chat, /findExisting/);
    assert.match(chat, /onSavePhotoMemory/);
    const photos = readFileSync('src/screens/photo-memories-screen.tsx', 'utf8');
    assert.match(photos, /svc\.list\(profile\.id/);
  });
});

describe('v1 release blocker — composer, workspace, notes empty copy', () => {
  it('keeps the Talk composer editable after attach/send and restores rejected attachments', () => {
    const composer = readFileSync('src/components/chat/chat-input-bar.tsx', 'utf8');
    assert.match(composer, /editable=\{true\}/);
    assert.match(composer, /shouldRestorePendingAttachments/);
    const chat = readFileSync('src/screens/chat-screen.tsx', 'utf8');
    assert.match(chat, /disabled=\{false\}/);
    assert.match(chat, /keyboardDismissMode="interactive"/);
    assert.equal(shouldRestorePendingAttachments(false), true);
    assert.equal(shouldRestorePendingAttachments(true), false);
  });

  it('collapses workspace to header/summary only', () => {
    const canvas = {
      id: 'c1',
      conversationId: 'conv',
      topic: 'Your plan',
      progressPercent: 40,
      updatedAt: '2026-01-01T00:00:00.000Z',
      sections: [
        { id: 'tasks', title: 'Tasks', items: ['A', 'B', 'C'] },
        { id: 'next', title: 'Next actions', items: ['D'] },
      ],
    };
    assert.equal(canvasSectionsForDisplay(canvas, false).length, 0);
    assert.equal(canvasSectionsForDisplay(canvas, true).length, 2);
    assert.equal(canvasChevronName(true), 'chevron-up');
    assert.equal(canvasChevronName(false), 'chevron-down');
  });

  it('uses folder-specific empty copy instead of implying all notes are gone', () => {
    const folderEmpty = notesListEmptyCopy({ folderName: 'Python', showArchived: false, favouritesOnly: false });
    assert.match(folderEmpty.title, /Python/);
    assert.doesNotMatch(folderEmpty.message, /^No notes yet/);
    const allEmpty = notesListEmptyCopy({ showArchived: false, favouritesOnly: false });
    assert.equal(allEmpty.title, 'No notes yet');
  });

  it('does not duplicate photo memories for the same local uri', async () => {
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
        keys.forEach((k) => this.data.delete(k));
      }
    }
    const svc = new PhotoMemoryService(new MemoryStorage());
    const first = await svc.create('u1', {
      title: 'Photo memory',
      caption: 'one',
      localUri: 'file:///img.jpg',
      occurredAt: '2026-01-01T00:00:00.000Z',
      category: 'everyday',
      people: [],
      isPrivate: false,
      pinned: false,
      favourite: false,
    });
    const dup = await svc.findExisting('u1', { localUri: 'file:///img.jpg' });
    assert.equal(dup?.id, first.id);
    const other = await svc.findExisting('u2', { localUri: 'file:///img.jpg' });
    assert.equal(other, null);
  });
});
