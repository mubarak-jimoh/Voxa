export type TalkAIErrorCode =
  | 'gateway_not_deployed'
  | 'gateway_not_configured'
  | 'not_authenticated'
  | 'invalid_session'
  | 'duplicate'
  | 'rate_limited'
  | 'usage_limited'
  | 'request_timeout'
  | 'message_too_large'
  | 'context_too_large'
  | 'image_too_large'
  | 'live_unavailable'
  | 'provider_not_configured'
  | 'provider_error'
  | 'database_error'
  | 'gateway_error'
  | 'network_error';

type Presentation = {
  message: string;
  userMessage: string;
  isDeploymentBlocker: boolean;
};

const PRESENTATIONS: Record<TalkAIErrorCode, Presentation> = {
  gateway_not_deployed: {
    message: 'AI gateway function is not deployed',
    userMessage: "Voxa couldn't connect to the AI service yet. Please try again shortly.",
    isDeploymentBlocker: true,
  },
  gateway_not_configured: {
    message: 'AI gateway URL not configured',
    userMessage: "Voxa isn't fully set up for chat yet. Please try again later.",
    isDeploymentBlocker: true,
  },
  not_authenticated: {
    message: 'Not authenticated for AI gateway',
    userMessage: 'Sign in to continue chatting with Voxa.',
    isDeploymentBlocker: false,
  },
  invalid_session: {
    message: 'Invalid or expired session for AI gateway',
    userMessage: 'Your session expired. Sign in again to keep chatting with Voxa.',
    isDeploymentBlocker: false,
  },
  duplicate: {
    message: 'Duplicate AI gateway request',
    userMessage: "That message didn't send cleanly. Please try again.",
    isDeploymentBlocker: false,
  },
  rate_limited: {
    message: 'AI gateway rate limited',
    userMessage: "You're sending messages quickly. Give Voxa a moment, then try again.",
    isDeploymentBlocker: false,
  },
  usage_limited: {
    message: 'AI gateway usage limit reached',
    userMessage:
      "You've reached today's chat limit. You can keep reading this conversation. Chat opens again after midnight UTC.",
    isDeploymentBlocker: false,
  },
  request_timeout: {
    message: 'AI gateway request timed out',
    userMessage: "Voxa didn't respond in time. Tap the message to retry — it won't send twice.",
    isDeploymentBlocker: false,
  },
  message_too_large: {
    message: 'AI gateway message too large',
    userMessage: 'That message is too long. Try shortening it and send again.',
    isDeploymentBlocker: false,
  },
  context_too_large: {
    message: 'AI gateway context too large',
    userMessage: "Voxa couldn't fit this conversation into one reply. Start a fresh chat and try again.",
    isDeploymentBlocker: false,
  },
  image_too_large: {
    message: 'AI gateway image too large or invalid',
    userMessage: "I couldn't process that photo. Please try attaching it again.",
    isDeploymentBlocker: false,
  },
  live_unavailable: {
    message: 'Live information could not be verified',
    userMessage:
      "I couldn't verify current information just now. Try again in a moment — I won't guess live scores, news, or weather.",
    isDeploymentBlocker: false,
  },
  provider_not_configured: {
    message: 'AI provider not configured on server',
    userMessage: "Voxa isn't fully set up for chat yet. Please try again later.",
    isDeploymentBlocker: true,
  },
  provider_error: {
    message: 'AI provider error',
    userMessage: "Voxa couldn't reach the AI service. Please try again in a moment.",
    isDeploymentBlocker: false,
  },
  database_error: {
    message: 'AI gateway database unavailable',
    userMessage: "Voxa couldn't connect to chat services yet. Please try again shortly.",
    isDeploymentBlocker: true,
  },
  gateway_error: {
    message: 'AI gateway request failed',
    userMessage: "Voxa couldn't send that message. Please try again.",
    isDeploymentBlocker: false,
  },
  network_error: {
    message: 'AI gateway network error',
    userMessage: "Voxa couldn't reach the network. Check your connection and try again.",
    isDeploymentBlocker: false,
  },
};

export class TalkAIError extends Error {
  readonly code: TalkAIErrorCode;
  readonly userMessage: string;
  readonly isDeploymentBlocker: boolean;

  constructor(code: TalkAIErrorCode, detail?: string) {
    const presentation = PRESENTATIONS[code];
    super(detail ? `${presentation.message}: ${detail}` : presentation.message);
    this.code = code;
    this.userMessage = presentation.userMessage;
    this.isDeploymentBlocker = presentation.isDeploymentBlocker;
  }
}

const SERVER_CODE_MAP: Record<string, TalkAIErrorCode> = {
  unauthorized: 'not_authenticated',
  invalid_session: 'invalid_session',
  missing_idempotency_key: 'gateway_error',
  invalid_request: 'gateway_error',
  invalid_json: 'gateway_error',
  duplicate: 'duplicate',
  provider_not_configured: 'provider_not_configured',
  provider_error: 'provider_error',
  database_error: 'database_error',
  daily_limit: 'usage_limited',
  monthly_limit: 'usage_limited',
  fair_use_exceeded: 'usage_limited',
  limits_unavailable: 'usage_limited',
  message_too_large: 'message_too_large',
  context_too_large: 'context_too_large',
  image_too_large: 'image_too_large',
  invalid_image: 'image_too_large',
  live_unavailable: 'live_unavailable',
  method_not_allowed: 'gateway_error',
};

export function classifyGatewayErrorMessage(message: string, code?: string): TalkAIErrorCode {
  const normalizedCode = code?.trim().toLowerCase();
  if (normalizedCode && SERVER_CODE_MAP[normalizedCode]) {
    return SERVER_CODE_MAP[normalizedCode];
  }
  if (normalizedCode === 'gateway_not_configured') return 'gateway_not_configured';
  if (normalizedCode === 'not_authenticated') return 'not_authenticated';

  const lower = message.toLowerCase();
  if (
    lower.includes('requested function was not found') ||
    lower.includes('function not found') ||
    lower.includes('failed to send a request to the edge function')
  ) {
    return 'gateway_not_deployed';
  }
  if (lower.includes('invalid session')) return 'invalid_session';
  if (lower.includes('not authenticated') || lower.includes('unauthorized')) return 'not_authenticated';
  if (lower.includes('provider not configured')) return 'provider_not_configured';
  if (lower.includes('provider error') || lower.includes('openai')) return 'provider_error';
  if (lower.includes('database') || lower.includes('relation') || lower.includes('does not exist')) {
    return 'database_error';
  }
  if (lower.includes('duplicate')) return 'duplicate';
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('aborted')) {
    return 'request_timeout';
  }
  if (
    lower.includes('daily limit') ||
    lower.includes('monthly limit') ||
    lower.includes('fair-use') ||
    lower.includes('fair use') ||
    lower.includes('usage limit')
  ) {
    return 'usage_limited';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'rate_limited';
  }
  if (lower.includes('message exceeds maximum size') || lower.includes('message too large')) {
    return 'message_too_large';
  }
  if (lower.includes('image exceeds') || lower.includes('invalid image') || lower.includes('image too large')) {
    return 'image_too_large';
  }
  if (lower.includes('conversation context exceeds') || lower.includes('context too large')) {
    return 'context_too_large';
  }
  if (lower.includes('could not be verified') || lower.includes('live_unavailable') || lower.includes('live information')) {
    return 'live_unavailable';
  }
  if (lower.includes('network') || lower.includes('fetch')) return 'network_error';
  if (lower.includes('non-2xx')) return 'gateway_error';
  return 'gateway_error';
}

const USER_UNSAFE_ERROR = /\[Voxa:|AI gateway|FAILURE \d+ms|stack|HTTP\/|status code|TalkAIError/i;

export function formatTalkErrorForUser(err: unknown): string {
  let message = "Voxa couldn't send that message. Please try again.";
  if (err instanceof TalkAIError) {
    message = err.userMessage;
  } else if (err instanceof Error) {
    const code = classifyGatewayErrorMessage(err.message);
    message = new TalkAIError(code).userMessage;
  }
  if (USER_UNSAFE_ERROR.test(message)) {
    return "Voxa couldn't send that message. Please try again.";
  }
  return message;
}

export function talkUserErrorLooksTechnical(message: string): boolean {
  return USER_UNSAFE_ERROR.test(message);
}

export function isGatewayDeploymentError(err: unknown): boolean {
  return err instanceof TalkAIError && err.code === 'gateway_not_deployed';
}

export function isTransientTalkRateLimit(code: TalkAIErrorCode): boolean {
  return code === 'rate_limited';
}

export function talkErrorRetryCanSucceed(code: TalkAIErrorCode | string | null): boolean {
  return code !== 'rate_limited' && code !== 'usage_limited';
}
