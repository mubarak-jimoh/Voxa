const MARKDOWN_LINK = /\[([^\]]+)\]\(\s*https?:\/\/[^)]+\)/gi;
const BARE_URL = /https?:\/\/[^\s)]+/gi;
const UTM_OPENAI = /utm_source=openai[^\s)]*/gi;
const DOMAIN_ONLY = /^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i;
const US_ZONE_PAREN = /\s*\([^)]*\b(?:PDT|PST|EDT|EST|PT|ET|Pacific Time|Eastern Time)\b[^)]*\)/gi;
const US_ZONE_CLOCK = /\s+\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?\s*(?:PDT|PST|EDT|EST)\b/gi;

function displayLinkLabel(label: string): string {
  const clean = label.trim();
  if (!clean || DOMAIN_ONLY.test(clean.replace(/^www\./i, ''))) return '';
  return clean;
}

export function stripForeignZoneTimes(text: string, timeZone?: string): string {
  if (!timeZone || !/^Europe\//i.test(timeZone)) return text;
  return text.replace(US_ZONE_PAREN, '').replace(US_ZONE_CLOCK, '');
}

/** Strip search citations and tracking URLs so Talk never shows raw markdown links. */
export function sanitizeTalkDisplayText(raw: string, options?: { timeZone?: string }): string {
  let text = raw.replace(/\r\n/g, '\n');
  text = text.replace(MARKDOWN_LINK, (_match, label: string) => displayLinkLabel(label));
  text = text.replace(/\(\s*https?:\/\/[^)]+\)/gi, '');
  text = text.replace(BARE_URL, '');
  text = text.replace(UTM_OPENAI, '');
  text = text.replace(/[?&]utm_[^=\s]+=[^\s)&]+/gi, '');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/\*\*/g, '');
  text = text.replace(/^[ \t]*\*+[ \t]*$/gm, '');
  text = stripForeignZoneTimes(text, options?.timeZone);
  text = text.replace(/\(\s*\)/g, '');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function talkDisplayContainsRawWebNoise(text: string): boolean {
  return (
    /https?:\/\//i.test(text) ||
    /\[[^\]]+\]\(\s*https?:\/\//i.test(text) ||
    /utm_source=openai/i.test(text)
  );
}
