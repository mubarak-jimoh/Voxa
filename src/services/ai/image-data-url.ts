import * as FileSystem from 'expo-file-system/legacy';

import { TalkAIError } from './talk-ai-errors';
import { validateVisionImageDataUrl } from './gateway-content';
import { buildVisionDataUrl, mimeTypeFromUri, normalizeVisionDataUrl } from './vision-data-url';

export { buildVisionDataUrl, mimeTypeFromUri, normalizeVisionDataUrl } from './vision-data-url';

/**
 * Convert a local image URI to a compact base64 data URL for OpenAI vision.
 * Does not accept remote http(s) URLs — the Edge Function must not fetch arbitrary URLs.
 */
export async function uriToVisionDataUrl(uri: string): Promise<string> {
  const trimmed = uri.trim();
  if (!trimmed) {
    throw new TalkAIError('image_too_large', 'Missing image');
  }
  if (trimmed.startsWith('data:')) {
    return assertValidVisionDataUrl(normalizeVisionDataUrl(trimmed));
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new TalkAIError('image_too_large', 'Remote image URLs are not allowed');
  }

  try {
    const info = await FileSystem.getInfoAsync(trimmed);
    if (!info.exists) {
      throw new TalkAIError('image_too_large', 'Could not read image');
    }
    if ('size' in info && typeof info.size === 'number' && info.size <= 0) {
      throw new TalkAIError('image_too_large', 'Could not read image');
    }
  } catch (err) {
    if (err instanceof TalkAIError) throw err;
    throw new TalkAIError('image_too_large', 'Could not read image');
  }

  let base64: string;
  try {
    base64 = await FileSystem.readAsStringAsync(trimmed, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch {
    throw new TalkAIError('image_too_large', 'Could not read image');
  }

  return assertValidVisionDataUrl(buildVisionDataUrl(base64, mimeTypeFromUri(trimmed)));
}

function assertValidVisionDataUrl(dataUrl: string): string {
  const check = validateVisionImageDataUrl(dataUrl);
  if (!check.allowed) {
    throw new TalkAIError(
      check.code === 'image_too_large' ? 'image_too_large' : 'message_too_large',
      check.message,
    );
  }
  return dataUrl;
}
