import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ActionIntentParser } from '../src/services/actions/action-intent-parser';
import { shouldPinTalkToLatest } from '../src/services/chat/talk-list-pin';
import {
  beginTalkSend,
  createTalkSendGuard,
  endTalkSend,
  isBurstRateLimitActive,
  isStaleTalkRateLimitBanner,
  noteBurstRateLimit,
  recoverTimedOutTalkSend,
  TALK_BURST_RATE_LIMIT_COOLDOWN_MS,
  TALK_SEND_TIMEOUT_MS,
} from '../src/services/chat/talk-send-guard';
import { classifyGatewayErrorMessage, TalkAIError } from '../src/services/ai/talk-ai-errors';
import { reminderScheduleConfirmation } from '../src/services/notifications/reminder-schedule-copy';
import { CHALLENGE_TEMPLATES } from '../src/services/phase12/companion-challenge-v2-service';
import { FetchTimeoutError } from '../src/utils/fetch-with-timeout';

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
    const soon = parser.parse('Remind me in 2 minutes to revise Python');
    assert.equal(soon?.action, 'set_reminder');
    if (soon?.action === 'set_reminder') {
      assert.match(soon.title, /revise python/i);
      const delta = soon.scheduledAt.getTime() - Date.now();
      assert.ok(delta > 60_000 && delta < 3 * 60_000);
    }
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
});
