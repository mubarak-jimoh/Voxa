import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { FREE_PLAN_LIMITS } from '../src/constants/pricing';
import { talkErrorRetryCanSucceed, TalkAIError } from '../src/services/ai/talk-ai-errors';
import {
  createTalkSendGuard,
  isStaleTalkRateLimitBanner,
  noteBurstRateLimit,
  resetTalkSendGuard,
  TALK_BURST_RATE_LIMIT_COOLDOWN_MS,
} from '../src/services/chat/talk-send-guard';
import {
  checkUsageAllowance,
  FREE_V1_AI_MESSAGES_DAILY,
  FREE_V1_AI_MESSAGES_MONTHLY,
  getDayKey,
} from '../supabase/functions/_shared/usage-guard.ts';

const FREE_LIMITS = {
  plan: 'free' as const,
  metric: 'ai_messages',
  dailyLimit: FREE_V1_AI_MESSAGES_DAILY,
  monthlyLimit: FREE_V1_AI_MESSAGES_MONTHLY,
  fairUseLimit: null,
};

describe('V1 free Talk usage limits', () => {
  it('documents the raised free daily and monthly allowance', () => {
    assert.equal(FREE_V1_AI_MESSAGES_DAILY, 150);
    assert.equal(FREE_V1_AI_MESSAGES_MONTHLY, 3000);
    assert.equal(FREE_PLAN_LIMITS.aiMessagesDaily, 150);
    assert.equal(FREE_PLAN_LIMITS.aiMessagesMonthly, 3000);
    const migration = readFileSync('supabase/migrations/202610070001_free_v1_chat_allowance.sql', 'utf8');
    assert.match(migration, /daily_limit = 150/);
    assert.match(migration, /monthly_limit = 3000/);
    assert.match(migration, /ai_messages/);
  });

  it('allows normal usage below the daily cap', () => {
    const result = checkUsageAllowance({
      plan: 'free',
      metric: 'ai_messages',
      amount: 1,
      dailyUsed: 20,
      monthlyUsed: 20,
      limits: FREE_LIMITS,
    });
    assert.equal(result.allowed, true);
  });

  it('blocks when the daily cap is reached', () => {
    const result = checkUsageAllowance({
      plan: 'free',
      metric: 'ai_messages',
      amount: 1,
      dailyUsed: 150,
      monthlyUsed: 150,
      limits: FREE_LIMITS,
    });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, 'daily_limit');
  });

  it('resets on a new UTC day key', () => {
    const monday = getDayKey(new Date('2026-10-07T23:30:00.000Z'));
    const tuesday = getDayKey(new Date('2026-10-08T00:01:00.000Z'));
    assert.equal(monday, '2026-10-07');
    assert.equal(tuesday, '2026-10-08');
    const afterReset = checkUsageAllowance({
      plan: 'free',
      metric: 'ai_messages',
      amount: 1,
      dailyUsed: 0,
      monthlyUsed: 150,
      limits: FREE_LIMITS,
    });
    assert.equal(afterReset.allowed, true);
  });

  it('keeps burst cooldown separate from the daily cap', () => {
    const guard = createTalkSendGuard();
    noteBurstRateLimit(guard, 1_000);
    assert.equal(
      isStaleTalkRateLimitBanner({
        code: 'rate_limited',
        shownAt: 1_000,
        now: 1_000 + TALK_BURST_RATE_LIMIT_COOLDOWN_MS,
      }),
      true,
    );
    assert.equal(
      isStaleTalkRateLimitBanner({
        code: 'usage_limited',
        shownAt: Date.parse('2026-10-07T12:00:00.000Z'),
        now: Date.parse('2026-10-07T23:00:00.000Z'),
      }),
      false,
    );
    assert.equal(
      isStaleTalkRateLimitBanner({
        code: 'usage_limited',
        shownAt: Date.parse('2026-10-07T12:00:00.000Z'),
        now: Date.parse('2026-10-08T00:01:00.000Z'),
      }),
      true,
    );
  });

  it('does not offer retry when the daily allowance is exhausted', () => {
    assert.equal(talkErrorRetryCanSucceed('usage_limited'), false);
    assert.equal(talkErrorRetryCanSucceed('rate_limited'), false);
    assert.equal(talkErrorRetryCanSucceed('network_error'), true);
    assert.match(new TalkAIError('usage_limited').userMessage, /midnight UTC/i);
    assert.doesNotMatch(new TalkAIError('usage_limited').userMessage, /upgrade|pro|paywall/i);
  });

  it('records usage only after a successful provider response', () => {
    const gateway = readFileSync('supabase/functions/ai-gateway/index.ts', 'utf8');
    const liveFail = gateway.indexOf("jsonError(502, 'live_unavailable'");
    const providerFail = gateway.indexOf("jsonError(502, 'provider_error'");
    const insert = gateway.indexOf("from('usage_events').insert");
    assert.ok(liveFail >= 0 && providerFail >= 0 && insert > liveFail && insert > providerFail);
  });

  it('does not mint a new idempotency key after a duplicate response', () => {
    const client = readFileSync('src/services/ai/gateway-ai-service.ts', 'utf8');
    assert.doesNotMatch(client, /duplicate[\s\S]{0,180}idempotencyKey = createUuid/);
  });

  it('scopes daily usage rows per user_id and does not inherit banners across accounts', () => {
    const gateway = readFileSync('supabase/functions/ai-gateway/index.ts', 'utf8');
    assert.match(gateway, /eq\('user_id', userId\)/);
    assert.match(gateway, /day_key/);
    const guard = createTalkSendGuard();
    noteBurstRateLimit(guard, 1_000);
    resetTalkSendGuard(guard);
    assert.equal(guard.burstCooldownUntil, 0);
  });
});
