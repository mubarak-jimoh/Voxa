export type UsageAllowance = {
  plan: 'free' | 'pro';
  metric: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  fairUseLimit: number | null;
};

export type UsageCheckResult =
  | { allowed: true; plan: 'free' | 'pro' }
  | { allowed: false; plan: 'free' | 'pro'; code: string; message: string };

/** Metrics the chat AI gateway may bill against. Client-supplied others are rejected. */
export const AI_GATEWAY_ALLOWED_METRICS = ['ai_messages'] as const;
export type AiGatewayAllowedMetric = (typeof AI_GATEWAY_ALLOWED_METRICS)[number];

export function resolveAiGatewayMetric(raw: string | undefined): AiGatewayAllowedMetric | null {
  const metric = (raw ?? 'ai_messages').trim();
  return (AI_GATEWAY_ALLOWED_METRICS as readonly string[]).includes(metric)
    ? (metric as AiGatewayAllowedMetric)
    : null;
}

export function getDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function getMonthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function resolvePlanFromSubscription(status?: string | null): 'free' | 'pro' {
  if (!status) return 'free';
  return ['active', 'trialing', 'billing_issue', 'grace'].includes(status) ? 'pro' : 'free';
}

export function checkUsageAllowance(input: {
  plan: 'free' | 'pro';
  metric: string;
  amount: number;
  dailyUsed: number;
  monthlyUsed: number;
  limits: UsageAllowance;
}): UsageCheckResult {
  const { plan, metric, amount, dailyUsed, monthlyUsed, limits } = input;

  // Fail closed: missing entitlement rows must never become unlimited OpenAI spend.
  const hasBound =
    limits.dailyLimit != null ||
    limits.monthlyLimit != null ||
    limits.fairUseLimit != null;
  if (!hasBound) {
    return {
      allowed: false,
      plan,
      code: 'limits_unavailable',
      message: 'Usage limits unavailable.',
    };
  }

  if (plan === 'pro' && limits.fairUseLimit != null) {
    if (dailyUsed + amount > limits.fairUseLimit) {
      return {
        allowed: false,
        plan,
        code: 'fair_use_exceeded',
        message: `Fair-use limit reached for ${metric}.`,
      };
    }
    return { allowed: true, plan };
  }

  if (limits.dailyLimit != null && dailyUsed + amount > limits.dailyLimit) {
    return {
      allowed: false,
      plan,
      code: 'daily_limit',
      message: `Daily limit reached for ${metric}.`,
    };
  }

  if (limits.monthlyLimit != null && monthlyUsed + amount > limits.monthlyLimit) {
    return {
      allowed: false,
      plan,
      code: 'monthly_limit',
      message: `Monthly limit reached for ${metric}.`,
    };
  }

  return { allowed: true, plan };
}

/** V1 free Talk allowance — enforced via entitlement_limits, not by making the gateway unlimited. */
export const FREE_V1_AI_MESSAGES_DAILY = 150;
export const FREE_V1_AI_MESSAGES_MONTHLY = 3000;

export const ABUSE_LIMITS = {
  maxUserMessageChars: 4_000,
  maxContextPayloadChars: 24_000,
  maxTotalPayloadChars: 28_000,
  maxAudioSeconds: 180,
  maxImageBytes: 12 * 1024 * 1024,
  /** Decoded vision image payload bound for ai-gateway multimodal turns. */
  maxVisionImageBytes: 4 * 1024 * 1024,
  maxRetryCount: 3,
} as const;

export const ALLOWED_VISION_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type GatewayTextPart = { type: 'text'; text: string };
export type GatewayImageUrlPart = { type: 'image_url'; image_url: { url: string } };
export type GatewayContentPart = GatewayTextPart | GatewayImageUrlPart;
export type GatewayMessageContent = string | GatewayContentPart[];

export type ChatPayloadSizeResult =
  | { allowed: true }
  | { allowed: false; plan: 'free' | 'pro'; code: string; message: string };

/** Count only textual characters — ignore base64 image payloads for text budgets. */
export function textCharsFromContent(content: GatewayMessageContent): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') total += part.text.length;
  }
  return total;
}

const VISION_DATA_URL_RE =
  /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;

export function validateVisionImageDataUrl(url: string): ChatPayloadSizeResult {
  if (typeof url !== 'string' || !url.trim()) {
    return { allowed: false, plan: 'free', code: 'invalid_image', message: 'Invalid image payload.' };
  }
  if (/^https?:\/\//i.test(url)) {
    return {
      allowed: false,
      plan: 'free',
      code: 'invalid_image',
      message: 'Remote image URLs are not allowed.',
    };
  }
  if (url.length > ABUSE_LIMITS.maxVisionImageBytes * 2) {
    // Fast reject before regex on huge strings (base64 ≈ 4/3 decoded size).
    return { allowed: false, plan: 'free', code: 'image_too_large', message: 'Image exceeds maximum size.' };
  }

  const match = VISION_DATA_URL_RE.exec(url.trim());
  if (!match) {
    return { allowed: false, plan: 'free', code: 'invalid_image', message: 'Invalid image payload.' };
  }

  const mime = match[1].toLowerCase();
  if (!(ALLOWED_VISION_MIME_TYPES as readonly string[]).includes(mime)) {
    return { allowed: false, plan: 'free', code: 'invalid_image', message: 'Invalid image payload.' };
  }

  const base64 = match[2].replace(/\s+/g, '');
  if (!base64 || base64.length % 4 !== 0) {
    return { allowed: false, plan: 'free', code: 'invalid_image', message: 'Invalid image payload.' };
  }

  // Approximate decoded size: base64 length * 3/4.
  const decodedBytes = Math.floor((base64.length * 3) / 4);
  if (decodedBytes > ABUSE_LIMITS.maxVisionImageBytes) {
    return { allowed: false, plan: 'free', code: 'image_too_large', message: 'Image exceeds maximum size.' };
  }

  return { allowed: true };
}

export function validateGatewayMessageContent(
  role: string,
  content: unknown,
): { ok: true; content: GatewayMessageContent } | { ok: false; code: string; message: string } {
  if (typeof content === 'string') {
    if (content.trim().length === 0) {
      return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
    }
    return { ok: true, content };
  }

  if (!Array.isArray(content) || content.length === 0) {
    return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
  }

  if (role !== 'user') {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Multipart content is only allowed on user messages.',
    };
  }

  const parts: GatewayContentPart[] = [];
  let hasText = false;
  let imageCount = 0;

  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
    }
    const part = rawPart as Record<string, unknown>;
    const keys = Object.keys(part);

    if (part.type === 'text') {
      if (keys.some((key) => key !== 'type' && key !== 'text')) {
        return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
      }
      if (typeof part.text !== 'string' || part.text.trim().length === 0) {
        return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
      }
      hasText = true;
      parts.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image_url') {
      if (keys.some((key) => key !== 'type' && key !== 'image_url')) {
        return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
      }
      const imageUrl = part.image_url;
      if (!imageUrl || typeof imageUrl !== 'object' || Array.isArray(imageUrl)) {
        return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
      }
      const imageObj = imageUrl as Record<string, unknown>;
      if (Object.keys(imageObj).some((key) => key !== 'url')) {
        return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
      }
      if (typeof imageObj.url !== 'string') {
        return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
      }
      const imageCheck = validateVisionImageDataUrl(imageObj.url);
      if (!imageCheck.allowed) {
        return { ok: false, code: imageCheck.code, message: imageCheck.message };
      }
      imageCount += 1;
      if (imageCount > 1) {
        return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
      }
      parts.push({ type: 'image_url', image_url: { url: imageObj.url } });
      continue;
    }

    return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
  }

  if (!hasText || imageCount !== 1) {
    return { ok: false, code: 'invalid_request', message: 'Invalid chat request' };
  }

  return { ok: true, content: parts };
}

export function validateChatPayloadSize(
  messages: { role: string; content: GatewayMessageContent }[],
): ChatPayloadSizeResult {
  for (const message of messages) {
    const validated = validateGatewayMessageContent(message.role, message.content);
    if (!validated.ok) {
      return {
        allowed: false,
        plan: 'free',
        code: validated.code,
        message: validated.message,
      };
    }
  }

  const totalChars = messages.reduce((sum, message) => sum + textCharsFromContent(message.content), 0);
  const userMessages = messages.filter((message) => message.role === 'user');
  const largestUserMessageChars = userMessages.reduce(
    (max, message) => Math.max(max, textCharsFromContent(message.content)),
    0,
  );

  if (largestUserMessageChars > ABUSE_LIMITS.maxUserMessageChars) {
    return {
      allowed: false,
      plan: 'free',
      code: 'message_too_large',
      message: 'Message exceeds maximum size.',
    };
  }

  const lastUserMessage = userMessages[userMessages.length - 1];
  const lastUserChars = lastUserMessage ? textCharsFromContent(lastUserMessage.content) : 0;
  const contextChars = totalChars - lastUserChars;

  if (contextChars > ABUSE_LIMITS.maxContextPayloadChars) {
    return {
      allowed: false,
      plan: 'free',
      code: 'context_too_large',
      message: 'Conversation context exceeds maximum size.',
    };
  }

  if (totalChars > ABUSE_LIMITS.maxTotalPayloadChars) {
    return {
      allowed: false,
      plan: 'free',
      code: 'context_too_large',
      message: 'Conversation context exceeds maximum size.',
    };
  }

  return { allowed: true };
}

export function validatePayloadSize(input: {
  messageChars?: number;
  audioSeconds?: number;
  imageBytes?: number;
}): UsageCheckResult | { allowed: true } {
  if (input.messageChars != null && input.messageChars > ABUSE_LIMITS.maxTotalPayloadChars) {
    return {
      allowed: false,
      plan: 'free',
      code: 'context_too_large',
      message: 'Conversation context exceeds maximum size.',
    };
  }
  if (input.audioSeconds != null && input.audioSeconds > ABUSE_LIMITS.maxAudioSeconds) {
    return {
      allowed: false,
      plan: 'free',
      code: 'audio_too_long',
      message: 'Audio exceeds maximum duration.',
    };
  }
  if (input.imageBytes != null && input.imageBytes > ABUSE_LIMITS.maxImageBytes) {
    return {
      allowed: false,
      plan: 'free',
      code: 'image_too_large',
      message: 'Image exceeds maximum size.',
    };
  }
  return { allowed: true };
}
