import type { GatewayMessageContent } from './usage-guard.ts';

export type GatewayChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: GatewayMessageContent;
};

export type ResponsesLiveResult = {
  text: string;
  sourceTitles: string[];
  usedWebSearch: boolean;
};

export function toResponsesLivePayload(messages: GatewayChatMessage[]): {
  instructions: string;
  input: Array<{ role: 'user' | 'assistant'; content: unknown }>;
} {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join('\n\n');

  const input = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: toResponsesContent(message.content),
    }));

  return { instructions, input };
}

function textFromContent(content: GatewayMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

function toResponsesContent(content: GatewayMessageContent): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'input_text', text: part.text };
    }
    return { type: 'input_image', image_url: part.image_url.url };
  });
}

export function parseResponsesLiveResult(payload: unknown): ResponsesLiveResult {
  if (!payload || typeof payload !== 'object') {
    return { text: '', sourceTitles: [], usedWebSearch: false };
  }
  const raw = payload as Record<string, unknown>;
  const titles = new Set<string>();
  let usedWebSearch = false;
  const textParts: string[] = [];

  if (typeof raw.output_text === 'string' && raw.output_text.trim()) {
    textParts.push(raw.output_text.trim());
  }

  const output = Array.isArray(raw.output) ? raw.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const type = typeof row.type === 'string' ? row.type : '';
    if (type === 'web_search_call' || type.includes('web_search')) usedWebSearch = true;
    collectSearchActionTitles(row, titles);

    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const node = part as Record<string, unknown>;
      if (node.type === 'output_text' && typeof node.text === 'string' && node.text.trim()) {
        textParts.push(node.text.trim());
      }
      collectCitationTitles(node, titles);
    }
  }

  collectCitationTitles(raw, titles);

  const text = (textParts[0] ?? '').trim();
  const incomplete = raw.status === 'incomplete' && !text;
  return {
    text: incomplete ? '' : text,
    sourceTitles: [...titles].slice(0, 3),
    usedWebSearch: usedWebSearch || titles.size > 0,
  };
}

export function classifyOpenAiLiveHttpFailure(status: number, errorCode?: string): string {
  const code = (errorCode ?? '').toLowerCase();
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400 && (code.includes('tool') || code.includes('unsupported'))) return 'unsupported_tool';
  if (status >= 500) return 'provider_http';
  return 'provider_http';
}

export function countryFromTimeZone(timeZone: string): string | undefined {
  const tz = timeZone.trim();
  if (!tz) return undefined;
  if (/^Europe\/London|^Europe\/(Guernsey|Jersey|Isle_of_Man)$/i.test(tz)) return 'GB';
  if (/^Europe\/Dublin$/i.test(tz)) return 'IE';
  if (/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage)/i.test(tz)) return 'US';
  if (/^Australia\//i.test(tz)) return 'AU';
  if (/^Pacific\/Auckland$/i.test(tz)) return 'NZ';
  if (/^Europe\/Paris$/i.test(tz)) return 'FR';
  if (/^Europe\/Berlin$/i.test(tz)) return 'DE';
  return undefined;
}

export function timeZoneFromInstructions(instructions: string): string | undefined {
  const match = instructions.match(/Timezone:\s*([^\n.]+)/i);
  return match?.[1]?.trim();
}

function collectSearchActionTitles(row: Record<string, unknown>, titles: Set<string>): void {
  const action = row.action;
  if (!action || typeof action !== 'object') return;
  const sources = (action as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return;
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const title = sanitizeSourceTitle(typeof (source as { title?: unknown }).title === 'string'
      ? (source as { title: string }).title
      : '');
    if (title) titles.add(title);
  }
}

function collectCitationTitles(node: Record<string, unknown>, titles: Set<string>): void {
  const annotations = Array.isArray(node.annotations) ? node.annotations : [];
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== 'object') continue;
    const item = annotation as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : '';
    if (!type.includes('citation') && type !== 'url_citation') continue;
    const title = sanitizeSourceTitle(typeof item.title === 'string' ? item.title : '');
    if (title) titles.add(title);
  }
}

export function sanitizeSourceTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return '';
  return trimmed.replace(/\s+/g, ' ').slice(0, 42);
}

export function formatSourceLine(titles: string[]): string {
  const clean = titles.map(sanitizeSourceTitle).filter(Boolean);
  if (clean.length === 0) return '';
  return `Sources · ${clean.join(' · ')}`;
}
