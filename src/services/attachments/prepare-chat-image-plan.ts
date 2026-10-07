import { CLIENT_VISION_LIMITS } from '../ai/gateway-content';

/** Longest edge for chat/vision images. Aspect ratio is preserved. */
export const CHAT_IMAGE_MAX_EDGE_PX = 1280;

/** First JPEG quality. Lower steps are used only if the file is still above the target. */
export const CHAT_IMAGE_JPEG_QUALITY = 0.7;

export const CHAT_IMAGE_QUALITY_STEPS = [0.7, 0.55, 0.4, 0.28] as const;

/** Ideal prepared size. Vision still accepts up to the server cap. */
export const CHAT_IMAGE_TARGET_MAX_BYTES = Math.round(1.5 * 1024 * 1024);

/** Must stay aligned with the ai-gateway vision cap. Do not raise it. */
export const CHAT_IMAGE_VISION_CAP_BYTES = CLIENT_VISION_LIMITS.maxVisionImageBytes;

export const CHAT_IMAGE_MIME = 'image/jpeg' as const;

export type PreparedChatImage = {
  localUri: string;
  mimeType: typeof CHAT_IMAGE_MIME;
  fileName: string;
  width: number;
  height: number;
  sizeBytes?: number;
};

export type PrepareChatImageInput = {
  localUri: string;
  mimeType?: string;
  fileName?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
};

export type ChatImageSaveResult = {
  uri: string;
  width: number;
  height: number;
  sizeBytes?: number;
};

export type ChatImageSaver = {
  inspect(uri: string): Promise<{ width: number; height: number }>;
  saveJpeg(input: {
    sourceUri: string;
    width: number;
    height: number;
    compress: number;
  }): Promise<ChatImageSaveResult>;
};

export class RemoteChatImageError extends Error {
  constructor() {
    super('Remote image URLs are not allowed');
    this.name = 'RemoteChatImageError';
  }
}

export class ChatImageTooLargeError extends Error {
  constructor() {
    super('Image exceeds maximum size.');
    this.name = 'ChatImageTooLargeError';
  }
}

export function isRemoteImageUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri.trim());
}

export function isHeicOrHeifSource(input: {
  mimeType?: string;
  fileName?: string;
  localUri?: string;
}): boolean {
  const mime = input.mimeType?.toLowerCase() ?? '';
  if (mime.includes('heic') || mime.includes('heif')) return true;
  const name = `${input.fileName ?? ''} ${input.localUri ?? ''}`.toLowerCase();
  return /\.heic(?:$|\?)/.test(name) || /\.heif(?:$|\?)/.test(name);
}

export function jpegFileNameFromSource(fileName?: string, uri?: string): string {
  const raw = (fileName?.trim() || uri?.split('/').pop()?.split('?')[0] || '').trim();
  const base = raw.replace(/\.[a-z0-9]+$/i, '');
  if (base && !base.includes('/') && !base.includes('\\')) return `${base}.jpg`;
  return `photo-${Date.now()}.jpg`;
}

export function durableChatImageFileName(now = Date.now()): string {
  return `voxa-chat-${now}.jpg`;
}

/** Scale so the longest edge is at most maxEdge. Does not upscale. */
export function resizeDimensionsToMaxEdge(
  width: number,
  height: number,
  maxEdge = CHAT_IMAGE_MAX_EDGE_PX,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const longest = Math.max(safeWidth, safeHeight);
  if (longest <= maxEdge) return { width: safeWidth, height: safeHeight };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

function toPrepared(saved: ChatImageSaveResult, input: PrepareChatImageInput): PreparedChatImage {
  const longest = Math.max(saved.width, saved.height);
  if (longest > CHAT_IMAGE_MAX_EDGE_PX) throw new ChatImageTooLargeError();
  return {
    localUri: saved.uri,
    mimeType: CHAT_IMAGE_MIME,
    fileName: jpegFileNameFromSource(input.fileName, input.localUri),
    width: saved.width,
    height: saved.height,
    sizeBytes: saved.sizeBytes,
  };
}

/**
 * Resize and transcode a local image to a chat JPEG.
 * Remote http(s) URLs are rejected. The saver performs the actual file work.
 */
export async function prepareChatImageWithSaver(
  input: PrepareChatImageInput,
  saver: ChatImageSaver,
): Promise<PreparedChatImage> {
  const uri = input.localUri.trim();
  if (!uri) throw new ChatImageTooLargeError();
  if (isRemoteImageUri(uri)) throw new RemoteChatImageError();

  const inspected = await saver.inspect(uri);
  const target = resizeDimensionsToMaxEdge(inspected.width, inspected.height);

  let last: ChatImageSaveResult | null = null;
  for (const compress of CHAT_IMAGE_QUALITY_STEPS) {
    const saved = await saver.saveJpeg({
      sourceUri: uri,
      width: target.width,
      height: target.height,
      compress,
    });
    last = saved;
    if (saved.sizeBytes == null || saved.sizeBytes <= CHAT_IMAGE_TARGET_MAX_BYTES) {
      return toPrepared(saved, input);
    }
  }

  if (last && (last.sizeBytes == null || last.sizeBytes <= CHAT_IMAGE_VISION_CAP_BYTES)) {
    return toPrepared(last, input);
  }
  throw new ChatImageTooLargeError();
}
