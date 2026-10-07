// Supabase Edge Function: protected AI gateway
// Deploy: supabase functions deploy ai-gateway
// Secrets: OPENAI_API_KEY, SUPABASE_SERVICE_ROLE_KEY (auto)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  ABUSE_LIMITS,
  checkUsageAllowance,
  getDayKey,
  getMonthKey,
  resolveAiGatewayMetric,
  resolvePlanFromSubscription,
  textCharsFromContent,
  validateChatPayloadSize,
  validateGatewayMessageContent,
  validatePayloadSize,
  type GatewayMessageContent,
} from '../_shared/usage-guard.ts';
import {
  classifyOpenAiLiveHttpFailure,
  countryFromTimeZone,
  formatSourceLine,
  parseResponsesLiveResult,
  timeZoneFromInstructions,
  toResponsesLivePayload,
} from '../_shared/openai-live-search.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
};

const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4o'] as const;
const MAX_MESSAGES = 25;
const MAX_OUTPUT_TOKENS = 500;
const LIVE_MAX_OUTPUT_TOKENS = 1800;
const DEFAULT_MODEL = 'gpt-4o-mini';
const LIVE_MODELS = ['gpt-4o-mini', 'gpt-4o'] as const;
const LIVE_TOOLS = ['web_search', 'web_search_preview'] as const;

type ChatRequest = {
  messages: {
    role: 'system' | 'user' | 'assistant';
    content: GatewayMessageContent;
  }[];
  model?: string;
  maxTokens?: number;
  metric?: string;
  amount?: number;
  liveSearch?: boolean;
};

type ErrorBody = { ok: false; code: string; message: string };

function jsonError(status: number, code: string, message: string): Response {
  const body: ErrorBody = { ok: false, code, message };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function jsonSuccess(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function resolveModel(requested?: string): string {
  const candidate = requested?.trim();
  if (candidate && ALLOWED_MODELS.includes(candidate as (typeof ALLOWED_MODELS)[number])) {
    return candidate;
  }
  const envModel = Deno.env.get('OPENAI_CHAT_MODEL')?.trim();
  if (envModel && ALLOWED_MODELS.includes(envModel as (typeof ALLOWED_MODELS)[number])) {
    return envModel;
  }
  return DEFAULT_MODEL;
}

function resolveMaxTokens(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return MAX_OUTPUT_TOKENS;
  }
  return Math.min(Math.floor(requested), MAX_OUTPUT_TOKENS);
}

type LiveSearchOk = {
  ok: true;
  text: string;
  sourceTitles: string[];
  inputTokens: number;
  outputTokens: number;
};

type LiveSearchFail = { ok: false; reason: string };

async function runLiveSearch(input: {
  openAiKey: string;
  preferredModel: string;
  instructions: string;
  input: unknown;
}): Promise<LiveSearchOk | LiveSearchFail> {
  const models = [
    input.preferredModel,
    ...LIVE_MODELS.filter((item) => item !== input.preferredModel),
  ];
  let lastReason = 'provider_http';

  for (const liveModel of models) {
    for (const toolType of LIVE_TOOLS) {
      const country = countryFromTimeZone(timeZoneFromInstructions(input.instructions) ?? '');
      const tool: Record<string, unknown> = { type: toolType };
      if (country) {
        tool.user_location = { type: 'approximate', country };
      }

      const liveResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.openAiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: liveModel,
          instructions: input.instructions,
          input: input.input,
          tools: [tool],
          tool_choice: 'required',
          include: ['web_search_call.action.sources'],
          max_output_tokens: LIVE_MAX_OUTPUT_TOKENS,
          store: false,
        }),
      });

      if (!liveResponse.ok) {
        const errJson = await liveResponse.json().catch(() => null);
        const errorCode =
          errJson && typeof errJson === 'object'
            ? String(
                (errJson as { error?: { code?: unknown; type?: unknown } }).error?.code ??
                  (errJson as { error?: { type?: unknown } }).error?.type ??
                  '',
              )
            : '';
        lastReason = classifyOpenAiLiveHttpFailure(liveResponse.status, errorCode);
        console.error(
          '[AI gateway] LIVE_SEARCH_FAILURE=' + lastReason + ' LIVE_SEARCH_HTTP=' + liveResponse.status,
        );
        if (liveResponse.status === 400) continue;
        return { ok: false, reason: lastReason };
      }

      const liveJson = await liveResponse.json();
      const parsed = parseResponsesLiveResult(liveJson);
      if (!parsed.usedWebSearch) {
        lastReason = 'no_tool_call';
        console.error('[AI gateway] LIVE_SEARCH_FAILURE=no_tool_call');
        continue;
      }
      if (!parsed.text) {
        lastReason = 'empty_text';
        console.error('[AI gateway] LIVE_SEARCH_FAILURE=empty_text');
        continue;
      }
      return {
        ok: true,
        text: parsed.text,
        sourceTitles: parsed.sourceTitles,
        inputTokens: Number(liveJson?.usage?.input_tokens ?? 0) || 0,
        outputTokens: Number(liveJson?.usage?.output_tokens ?? 0) || 0,
      };
    }
  }

  return { ok: false, reason: lastReason };
}

function parseChatRequest(payload: unknown): ChatRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.messages) || raw.messages.length === 0 || raw.messages.length > MAX_MESSAGES) {
    return null;
  }

  const messages: ChatRequest['messages'] = [];
  for (const item of raw.messages) {
    if (!item || typeof item !== 'object') return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    const validated = validateGatewayMessageContent(role, content);
    if (!validated.ok) return null;
    messages.push({ role, content: validated.content });
  }

  const metricRaw = typeof raw.metric === 'string' ? raw.metric.trim() : undefined;
  // Chat gateway always bills exactly one ai_messages unit — ignore client amount inflation.
  const amount = 1;

  return {
    messages,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined,
    metric: metricRaw || undefined,
    amount,
    liveSearch: raw.liveSearch === true,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname.endsWith('/health')) {
    return jsonSuccess({ service: 'ai-gateway' });
  }

  if (req.method !== 'POST') {
    return jsonError(405, 'method_not_allowed', 'Method not allowed');
  }

  // Accept Authorization case-insensitively (HTTP headers are case-insensitive).
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization');
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) {
    return jsonError(401, 'unauthorized', 'Unauthorized');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonError(500, 'gateway_error', 'AI gateway error');
  }

  // Validate the caller with the user JWT on an anon-scoped client.
  // Do NOT use service-role + getUser(jwt): with modern JWT signing keys that path
  // can reject valid new sessions (same secure pattern as delete-account).
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) {
    return jsonError(401, 'invalid_session', 'Invalid session');
  }

  const userId = authData.user.id;
  // Privileged DB / usage tracking still uses the service-role client.
  const supabase = createClient(supabaseUrl, serviceKey);

  let rawPayload: unknown;
  try {
    rawPayload = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', 'Invalid JSON');
  }

  const payload = parseChatRequest(rawPayload);
  if (!payload) {
    return jsonError(400, 'invalid_request', 'Invalid chat request');
  }

  try {
    return await handleGatewayChat({
      supabase,
      userId,
      payload,
      idempotencyKey: req.headers.get('x-idempotency-key')?.trim(),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[AI gateway] unhandled error', detail.slice(0, 240));
    return jsonError(500, 'gateway_error', 'AI gateway error');
  }
});

async function handleGatewayChat(input: {
  supabase: ReturnType<typeof createClient>;
  userId: string;
  payload: ChatRequest;
  idempotencyKey?: string;
}): Promise<Response> {
  const { supabase, userId, payload } = input;
  const idempotencyKey = input.idempotencyKey;
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return jsonError(400, 'missing_idempotency_key', 'Missing or invalid x-idempotency-key');
  }

  const messageChars = payload.messages.reduce(
    (sum, msg) => sum + textCharsFromContent(msg.content),
    0,
  );
  const sizeCheck = validateChatPayloadSize(payload.messages);
  if (!sizeCheck.allowed) {
    return new Response(JSON.stringify({ ok: false, ...sizeCheck }), {
      status: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const metric = resolveAiGatewayMetric(payload.metric);
  if (!metric) {
    return jsonError(400, 'invalid_metric', 'Invalid usage metric');
  }
  const amount = 1;

  let existingEvent: { id: string } | null = null;
  try {
    const { data, error } = await supabase
      .from('usage_events')
      .select('id')
      .eq('event_ref_id', idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    existingEvent = data;
  } catch (err) {
    console.error('[AI gateway] usage_events lookup failed', String(err).slice(0, 200));
    return jsonError(503, 'database_error', 'Usage tracking unavailable');
  }

  if (existingEvent) {
    return new Response(JSON.stringify({ ok: false, duplicate: true, code: 'duplicate', message: 'Duplicate request' }), {
      status: 409,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let subscription: { status?: string | null } | null = null;
  let limitsRow: {
    daily_limit: number | null;
    monthly_limit: number | null;
    fair_use_limit: number | null;
  } | null = null;
  let dailyUsage: { daily_requests?: number | null } | null = null;
  let monthlyUsage: { monthly_requests?: number | null } | null = null;

  try {
    const subscriptionResult = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', userId)
      .maybeSingle();
    if (subscriptionResult.error) throw subscriptionResult.error;
    subscription = subscriptionResult.data;

    const plan = resolvePlanFromSubscription(subscription?.status);
    const dayKey = getDayKey();
    const monthKey = getMonthKey();

    const [limitsResult, dailyResult, monthlyResult] = await Promise.all([
      supabase
        .from('entitlement_limits')
        .select('daily_limit, monthly_limit, fair_use_limit')
        .eq('plan', plan)
        .eq('metric', metric)
        .maybeSingle(),
      supabase
        .from('daily_usage')
        .select('daily_requests')
        .eq('user_id', userId)
        .eq('day_key', dayKey)
        .maybeSingle(),
      supabase
        .from('monthly_usage')
        .select('monthly_requests')
        .eq('user_id', userId)
        .eq('month_key', monthKey)
        .maybeSingle(),
    ]);

    if (limitsResult.error) throw limitsResult.error;
    if (dailyResult.error) throw dailyResult.error;
    if (monthlyResult.error) throw monthlyResult.error;

    limitsRow = limitsResult.data;
    dailyUsage = dailyResult.data;
    monthlyUsage = monthlyResult.data;

    if (!limitsRow) {
      return new Response(
        JSON.stringify({
          ok: false,
          allowed: false,
          plan,
          code: 'limits_unavailable',
          message: 'Usage limits unavailable.',
        }),
        {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const allowance = checkUsageAllowance({
      plan,
      metric,
      amount,
      dailyUsed: dailyUsage?.daily_requests ?? 0,
      monthlyUsed: monthlyUsage?.monthly_requests ?? 0,
      limits: {
        plan,
        metric,
        dailyLimit: limitsRow.daily_limit ?? null,
        monthlyLimit: limitsRow.monthly_limit ?? null,
        fairUseLimit: limitsRow.fair_use_limit ?? null,
      },
    });

    if (!allowance.allowed) {
      return new Response(JSON.stringify({ ok: false, ...allowance }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const openAiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openAiKey) {
      return jsonError(503, 'provider_not_configured', 'AI provider not configured');
    }

    const model = resolveModel(payload.model);
    const maxTokens = resolveMaxTokens(payload.maxTokens);

    let content = '';
    let sourceLine = '';
    let inputTokens = 0;
    let outputTokens = 0;

    if (payload.liveSearch) {
      const live = toResponsesLivePayload(payload.messages);
      const liveResult = await runLiveSearch({
        openAiKey,
        preferredModel: model,
        instructions: live.instructions,
        input: live.input,
      });
      if (!liveResult.ok) {
        console.error('[AI gateway] LIVE_SEARCH_FAILURE=' + liveResult.reason);
        return jsonError(502, 'live_unavailable', 'Current information could not be verified');
      }
      console.log('[AI gateway] LIVE_SEARCH_RESULT=success LIVE_SEARCH_TOOL_CALLED=true');
      content = liveResult.text;
      sourceLine = formatSourceLine(liveResult.sourceTitles);
      inputTokens = liveResult.inputTokens;
      outputTokens = liveResult.outputTokens;
    } else {
      const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openAiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: payload.messages,
          max_tokens: maxTokens,
          temperature: 0.8,
        }),
      });

      if (!openAiResponse.ok) {
        const errorText = await openAiResponse.text();
        console.error('[AI gateway] OpenAI error', openAiResponse.status, errorText.slice(0, 200));
        return jsonError(502, 'provider_error', 'AI provider error');
      }

      const completion = await openAiResponse.json();
      content = completion.choices?.[0]?.message?.content ?? '';
      inputTokens = completion.usage?.prompt_tokens ?? 0;
      outputTokens = completion.usage?.completion_tokens ?? 0;
    }

    await supabase.from('usage_events').insert({
      user_id: userId,
      event_ref_id: idempotencyKey,
      metric,
      amount,
      model,
      metadata: { inputTokens, outputTokens, messageChars },
    });

    await supabase.from('daily_usage').upsert(
      {
        user_id: userId,
        day_key: dayKey,
        daily_requests: (dailyUsage?.daily_requests ?? 0) + amount,
        ai_input_tokens: inputTokens,
        ai_output_tokens: outputTokens,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,day_key' },
    );

    await supabase.from('monthly_usage').upsert(
      {
        user_id: userId,
        month_key: monthKey,
        monthly_requests: (monthlyUsage?.monthly_requests ?? 0) + amount,
        ai_input_tokens: inputTokens,
        ai_output_tokens: outputTokens,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,month_key' },
    );

    return jsonSuccess({
      content,
      sourceLine,
      usage: { inputTokens, outputTokens, plan },
      limits: ABUSE_LIMITS,
    });
  } catch (err) {
    console.error('[AI gateway] billing tables unavailable', String(err).slice(0, 200));
    return jsonError(503, 'database_error', 'Usage tracking unavailable');
  }
}
