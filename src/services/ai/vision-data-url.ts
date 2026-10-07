import { TalkAIError } from './talk-ai-errors';

const VISION_DATA_URL_RE =
  /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;

export function mimeTypeFromUri(uri: string): string {
  const path = uri.split('?')[0]?.toLowerCase() ?? '';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/jpeg';
}

export function buildVisionDataUrl(base64: string, mimeType = 'image/jpeg'): string {
  const compact = base64.replace(/\s+/g, '');
  if (!compact) {
    throw new TalkAIError('image_too_large', 'Could not read image');
  }
  return `data:${mimeType};base64,${compact}`;
}

export function normalizeVisionDataUrl(dataUrl: string): string {
  const match = VISION_DATA_URL_RE.exec(dataUrl.trim());
  if (!match) {
    throw new TalkAIError('image_too_large', 'Invalid image payload');
  }
  return buildVisionDataUrl(match[2], match[1].toLowerCase());
}
