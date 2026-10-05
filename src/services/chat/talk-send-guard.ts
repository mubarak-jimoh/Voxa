export type TalkSendRejectReason = 'in_flight' | 'duplicate_submit' | 'burst_cooldown';

export const TALK_SEND_TIMEOUT_MS = 50_000;
export const TALK_BURST_RATE_LIMIT_COOLDOWN_MS = 12_000;
const DUPLICATE_WINDOW_MS = 1500;

export type TalkSendGuard = {
  inFlight: boolean;
  startedAt: number;
  lastFingerprint: string | null;
  lastAcceptedAt: number;
  lastText: string;
  burstCooldownUntil: number;
};

export function createTalkSendGuard(): TalkSendGuard {
  return {
    inFlight: false,
    startedAt: 0,
    lastFingerprint: null,
    lastAcceptedAt: 0,
    lastText: '',
    burstCooldownUntil: 0,
  };
}

export function talkSendFingerprint(text: string, conversationId: string): string {
  return `${conversationId}::${text.trim()}`;
}

export function isTalkSendTimedOut(guard: TalkSendGuard, now = Date.now()): boolean {
  return guard.inFlight && guard.startedAt > 0 && now - guard.startedAt >= TALK_SEND_TIMEOUT_MS;
}

export function recoverTimedOutTalkSend(guard: TalkSendGuard, now = Date.now()): boolean {
  if (!isTalkSendTimedOut(guard, now)) return false;
  guard.inFlight = false;
  return true;
}

export function noteBurstRateLimit(guard: TalkSendGuard, now = Date.now()): void {
  guard.burstCooldownUntil = now + TALK_BURST_RATE_LIMIT_COOLDOWN_MS;
}

export function clearExpiredTalkCooldowns(guard: TalkSendGuard, now = Date.now()): boolean {
  if (guard.burstCooldownUntil > 0 && now >= guard.burstCooldownUntil) {
    guard.burstCooldownUntil = 0;
    return true;
  }
  return false;
}

export function isBurstRateLimitActive(guard: TalkSendGuard, now = Date.now()): boolean {
  return guard.burstCooldownUntil > now;
}

export function beginTalkSend(
  guard: TalkSendGuard,
  input: { text: string; conversationId: string; now?: number },
): { accepted: true } | { accepted: false; reason: TalkSendRejectReason } {
  const now = input.now ?? Date.now();
  if (isTalkSendTimedOut(guard, now)) {
    recoverTimedOutTalkSend(guard, now);
  }
  if (guard.inFlight) {
    return { accepted: false, reason: 'in_flight' };
  }
  if (isBurstRateLimitActive(guard, now)) {
    return { accepted: false, reason: 'burst_cooldown' };
  }
  const fingerprint = talkSendFingerprint(input.text, input.conversationId);
  if (
    fingerprint === guard.lastFingerprint &&
    now - guard.lastAcceptedAt < DUPLICATE_WINDOW_MS
  ) {
    return { accepted: false, reason: 'duplicate_submit' };
  }
  guard.inFlight = true;
  guard.startedAt = now;
  guard.lastFingerprint = fingerprint;
  guard.lastAcceptedAt = now;
  guard.lastText = input.text.trim();
  return { accepted: true };
}

export function endTalkSend(guard: TalkSendGuard): void {
  guard.inFlight = false;
}

export function composerTextAfterFailedSend(input: {
  sentText: string;
  persistedNewUserTurn: boolean;
  currentComposer: string;
}): string {
  if (input.persistedNewUserTurn) return input.currentComposer;
  return input.currentComposer.trim() ? input.currentComposer : input.sentText;
}

export function talkGatewayGenerationCountForAcceptedSends(acceptedCount: number): number {
  return acceptedCount;
}

export function isStaleTalkRateLimitBanner(input: {
  code: string | null;
  shownAt: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  if (!input.code || input.shownAt <= 0) return false;
  if (input.code !== 'rate_limited') return false;
  return now - input.shownAt >= TALK_BURST_RATE_LIMIT_COOLDOWN_MS;
}
