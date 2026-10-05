import { getAiGatewayUrlFromEnv } from '../../config/ai-gateway-env';
import { getSupabaseAnonKey, hasSupabaseConfig } from '../../config/env';
import { getSupabaseClient } from '../supabase/client';
import { talkPerf, talkPerfNow } from '../../utils/talk-perf';
import { isGatewayAuthFailure } from './ai-gateway-auth';
import {
  classifyGatewayErrorMessage,
  TalkAIError,
} from './talk-ai-errors';
import { fetchWithTimeout } from '../../utils/fetch-with-timeout';
import {
  logGatewayDiagnostic,
  resolveGatewayUrl,
  sanitizeGatewayFailure,
  getGatewayProviderLabel,
} from './gateway-diagnostics';

import {
  type GatewayChatMessage,
} from './gateway-context-budget';

export { isGatewayAuthFailure } from './ai-gateway-auth';

export type GatewayChatRequest = {
  messages: GatewayChatMessage[];
  model?: string;
  maxTokens?: number;
  metric?: string;
  amount?: number;
  idempotencyKey: string;
};

export type GatewayChatResponse =
  | { ok: true; content: string }
  | { ok: false; code?: string; message: string; httpStatus?: number };

type GatewayErrorPayload = {
  ok?: boolean;
  duplicate?: boolean;
  content?: string;
  code?: string;
  message?: string;
  error?: string;
};

type CachedAccessToken = { token: string; expiresAtSec: number };

let cachedAccessToken: CachedAccessToken | null = null;

/** Clear module-level token cache (e.g. on sign-out or after auth failure). */
export function clearGatewayAccessTokenCache(): void {
  cachedAccessToken = null;
}

async function resolveAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<string | null> {
  const forceRefresh = options?.forceRefresh === true;

  if (
    !forceRefresh &&
    cachedAccessToken &&
    cachedAccessToken.expiresAtSec * 1000 > Date.now() + 60_000
  ) {
    return cachedAccessToken.token;
  }

  const client = getSupabaseClient();

  if (forceRefresh) {
    clearGatewayAccessTokenCache();
    const { data: refreshed, error } = await client.auth.refreshSession();
    if (!error && refreshed.session?.access_token) {
      const token = refreshed.session.access_token;
      const expiresAt = refreshed.session.expires_at;
      if (typeof expiresAt === 'number') {
        cachedAccessToken = { token, expiresAtSec: expiresAt };
      }
      return token;
    }
    // Refresh failed — fall through to getSession for whatever is still stored.
  }

  const { data: sessionData } = await client.auth.getSession();
  let token = sessionData.session?.access_token ?? null;
  let expiresAt = sessionData.session?.expires_at;

  if (!token) return null;

  const expiresSoon =
    typeof expiresAt === 'number' && expiresAt * 1000 <= Date.now() + 60_000;

  if (expiresSoon) {
    const { data: refreshed, error } = await client.auth.refreshSession();
    if (!error && refreshed.session?.access_token) {
      token = refreshed.session.access_token;
      expiresAt = refreshed.session.expires_at;
    }
  }

  if (token && typeof expiresAt === 'number') {
    cachedAccessToken = { token, expiresAtSec: expiresAt };
  }

  return token;
}

function parseGatewayPayload(raw: unknown): GatewayErrorPayload {
  if (!raw || typeof raw !== 'object') return {};
  return raw as GatewayErrorPayload;
}

async function postToGateway(
  request: GatewayChatRequest,
  token: string,
): Promise<{ payload: GatewayErrorPayload; httpStatus: number }> {
  const gatewayUrl = getAiGatewayUrlFromEnv();
  const anonKey = getSupabaseAnonKey();
  if (!gatewayUrl || !anonKey) {
    throw new TalkAIError('gateway_not_configured');
  }

  const response = await fetchWithTimeout(gatewayUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
      'x-idempotency-key': request.idempotencyKey,
    },
    body: JSON.stringify({
      messages: request.messages,
      model: request.model,
      maxTokens: request.maxTokens,
      metric: request.metric,
      amount: request.amount,
    }),
  });

  const payload = parseGatewayPayload(await response.json().catch(() => ({})));
  return { payload, httpStatus: response.status };
}

function mapGatewayFailure(
  payload: GatewayErrorPayload,
  httpStatus: number,
  fallbackMessage: string,
): Extract<GatewayChatResponse, { ok: false }> {
  if (payload.duplicate) {
    return { ok: false, code: 'duplicate', message: 'Duplicate AI request', httpStatus };
  }

  const message = payload.message ?? payload.error ?? fallbackMessage;
  const code = classifyGatewayErrorMessage(message, payload.code);
  return { ok: false, code, message, httpStatus };
}

function finalizeGatewayResult(
  payload: GatewayErrorPayload,
  httpStatus: number,
): GatewayChatResponse {
  if (httpStatus >= 200 && httpStatus < 300) {
    if (typeof payload.content === 'string' && payload.content.trim()) {
      return { ok: true, content: payload.content };
    }
    return mapGatewayFailure(payload, httpStatus, 'AI gateway returned an empty response.');
  }

  const failure = mapGatewayFailure(
    payload,
    httpStatus,
    httpStatus === 404 ? 'Requested function was not found' : 'Gateway error',
  );

  if (!failure.ok) {
    logGatewayDiagnostic({
      provider: getGatewayProviderLabel(),
      gatewayUrl: resolveGatewayUrl(),
      hasSession: true,
      httpStatus,
      gatewayCode: failure.code,
      sanitizedMessage: sanitizeGatewayFailure({
        httpStatus,
        message: failure.message,
        code: failure.code,
      }).code,
    });
  }

  return failure;
}

export async function invokeAiGatewayChat(request: GatewayChatRequest): Promise<GatewayChatResponse> {
  if (!hasSupabaseConfig()) {
    return { ok: false, code: 'gateway_not_configured', message: 'AI gateway URL not configured' };
  }

  const authStarted = talkPerfNow();
  let token = await resolveAccessToken();
  talkPerf('auth-session', talkPerfNow() - authStarted);
  if (!token) {
    return { ok: false, code: 'not_authenticated', message: 'Not authenticated' };
  }

  try {
    const httpStarted = talkPerfNow();
    let { payload, httpStatus } = await postToGateway(request, token);
    talkPerf('gateway-http', talkPerfNow() - httpStarted);

    let result = finalizeGatewayResult(payload, httpStatus);

    // At most one refresh + retry on authentication failure (never loop).
    if (
      !result.ok &&
      isGatewayAuthFailure(result.httpStatus, result.code)
    ) {
      clearGatewayAccessTokenCache();
      const refreshedToken = await resolveAccessToken({ forceRefresh: true });
      if (refreshedToken) {
        token = refreshedToken;
        const retryStarted = talkPerfNow();
        ({ payload, httpStatus } = await postToGateway(request, token));
        talkPerf('gateway-http-retry', talkPerfNow() - retryStarted);
        result = finalizeGatewayResult(payload, httpStatus);
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    logGatewayDiagnostic({
      provider: getGatewayProviderLabel(),
      gatewayUrl: resolveGatewayUrl(),
      hasSession: true,
      gatewayCode: classifyGatewayErrorMessage(message),
      sanitizedMessage: classifyGatewayErrorMessage(message),
    });
    return {
      ok: false,
      code: classifyGatewayErrorMessage(message),
      message,
    };
  }
}

let gatewayWarmAttempted = false;

/**
 * Wake the Edge Function isolate without generating a model reply or sending chat content.
 * Safe to fire-and-forget once per JS session.
 */
export function warmAiGateway(): void {
  if (gatewayWarmAttempted) return;
  const gatewayUrl = getAiGatewayUrlFromEnv();
  const anonKey = getSupabaseAnonKey();
  if (!gatewayUrl || !anonKey) return;
  gatewayWarmAttempted = true;
  void (async () => {
    const warmStarted = talkPerfNow();
    await resolveAccessToken().catch(() => null);
    await fetch(gatewayUrl, {
      method: 'OPTIONS',
      headers: { apikey: anonKey },
    }).catch(() => undefined);
    talkPerf('gateway-warm', talkPerfNow() - warmStarted);
  })();
}

/** Throws TalkAIError for gateway failures — used by GatewayAIService. */
export async function invokeAiGatewayChatOrThrow(request: GatewayChatRequest): Promise<string> {
  const result = await invokeAiGatewayChat(request);
  if (result.ok) return result.content;

  const code = classifyGatewayErrorMessage(result.message, result.code);
  throw new TalkAIError(code, result.message);
}
