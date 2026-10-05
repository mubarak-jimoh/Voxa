import { createUuid } from '../../types';
import { getSupabaseAnonKey, hasSupabaseConfig } from '../../config/env';
import { getTtsGatewayUrlFromEnv } from '../../config/tts-gateway-env';
import { fetchWithTimeout } from '../../utils/fetch-with-timeout';
import { clearGatewayAccessTokenCache } from '../ai/ai-gateway-client';
import { isGatewayAuthFailure } from '../ai/ai-gateway-auth';
import { getSupabaseClient } from '../supabase/client';
import {
  clipTextForTtsGateway,
  resolveAllowedTtsVoice,
  resolveTtsSpeed,
  validateTtsText,
} from './tts-contract';

export type TtsGatewayRequest = {
  text: string;
  voice: string;
  speed?: number;
  idempotencyKey?: string;
};

export type TtsGatewayResult =
  | { ok: true; audioBytes: ArrayBuffer; voice: string; mimeType: string }
  | { ok: false; code: string; message: string; httpStatus?: number };

type CachedAccessToken = { token: string; expiresAtSec: number };

let cachedAccessToken: CachedAccessToken | null = null;

async function resolveAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null> {
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
    cachedAccessToken = null;
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

async function postTts(
  request: TtsGatewayRequest,
  token: string,
): Promise<{ httpStatus: number; audioBytes?: ArrayBuffer; voice?: string; errorBody?: { code?: string; message?: string } }> {
  const gatewayUrl = getTtsGatewayUrlFromEnv();
  const anonKey = getSupabaseAnonKey();
  if (!gatewayUrl || !anonKey) {
    return { httpStatus: 0, errorBody: { code: 'gateway_not_configured', message: 'TTS gateway not configured' } };
  }

  const voice = resolveAllowedTtsVoice(request.voice);
  const textCheck = validateTtsText(clipTextForTtsGateway(request.text));
  if (!voice || !textCheck.ok) {
    return {
      httpStatus: 400,
      errorBody: {
        code: !voice ? 'invalid_voice' : textCheck.ok ? 'invalid_text' : textCheck.code,
        message: !voice ? 'Voice is not allowed' : textCheck.ok ? 'Invalid text' : textCheck.message,
      },
    };
  }

  const idempotencyKey = request.idempotencyKey?.trim() || createUuid();
  const response = await fetchWithTimeout(gatewayUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
      'x-idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      text: textCheck.text,
      voice,
      speed: resolveTtsSpeed(request.speed),
    }),
  });

  const contentType = response.headers.get('Content-Type') ?? '';
  if (response.ok && contentType.includes('audio/')) {
    const audioBytes = await response.arrayBuffer();
    return {
      httpStatus: response.status,
      audioBytes,
      voice: response.headers.get('X-Voxa-Voice') ?? voice,
    };
  }

  const errorBody = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  };
  return { httpStatus: response.status, errorBody };
}

/**
 * Authenticated TTS via Supabase Edge Function (server OPENAI_API_KEY).
 * Returns MPEG audio bytes for local playback — never logs audio content.
 */
export async function invokeTtsGateway(request: TtsGatewayRequest): Promise<TtsGatewayResult> {
  if (!hasSupabaseConfig() || !getTtsGatewayUrlFromEnv()) {
    return { ok: false, code: 'gateway_not_configured', message: 'TTS gateway not configured' };
  }

  let token = await resolveAccessToken();
  if (!token) {
    return { ok: false, code: 'not_authenticated', message: 'Not authenticated' };
  }

  try {
    let result = await postTts(request, token);

    if (
      result.errorBody &&
      isGatewayAuthFailure(result.httpStatus, result.errorBody.code)
    ) {
      cachedAccessToken = null;
      clearGatewayAccessTokenCache();
      const refreshed = await resolveAccessToken({ forceRefresh: true });
      if (refreshed) {
        token = refreshed;
        result = await postTts(request, token);
      }
    }

    if (result.audioBytes && result.audioBytes.byteLength > 0) {
      return {
        ok: true,
        audioBytes: result.audioBytes,
        voice: result.voice ?? request.voice,
        mimeType: 'audio/mpeg',
      };
    }

    return {
      ok: false,
      code: result.errorBody?.code ?? 'gateway_error',
      message: result.errorBody?.message ?? 'TTS gateway error',
      httpStatus: result.httpStatus,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { ok: false, code: 'network_error', message };
  }
}

export async function invokeTtsGatewayOrThrow(request: TtsGatewayRequest): Promise<{
  audioBytes: ArrayBuffer;
  voice: string;
}> {
  const result = await invokeTtsGateway(request);
  if (!result.ok) {
    throw new Error(result.message || result.code);
  }
  return { audioBytes: result.audioBytes, voice: result.voice };
}
