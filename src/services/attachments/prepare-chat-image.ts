import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

import { TalkAIError } from '../ai/talk-ai-errors';
import {
  ChatImageTooLargeError,
  durableChatImageFileName,
  PrepareChatImageInput,
  PreparedChatImage,
  RemoteChatImageError,
  prepareChatImageWithSaver,
} from './prepare-chat-image-plan';

async function fileSize(uri: string): Promise<number | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && 'size' in info && typeof info.size === 'number') return info.size;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Prepare a picked or captured photo before it becomes a pending attachment.
 * Output is a local JPEG, longest edge about 1280px, used for preview, upload, and vision.
 */
export async function persistPreparedChatJpeg(sourceUri: string): Promise<string> {
  const cache = FileSystem.cacheDirectory;
  if (!cache) return sourceUri;
  const dest = `${cache}${durableChatImageFileName()}`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) {
      throw new TalkAIError('image_too_large', 'Could not read image');
    }
    if ('size' in info && typeof info.size === 'number' && info.size <= 0) {
      throw new TalkAIError('image_too_large', 'Could not read image');
    }
    return dest;
  } catch (err) {
    if (err instanceof TalkAIError) throw err;
    throw new TalkAIError('image_too_large', 'Could not read image');
  }
}

export async function prepareChatImage(input: PrepareChatImageInput): Promise<PreparedChatImage> {
  try {
    const prepared = await prepareChatImageWithSaver(input, {
      async inspect(uri) {
        const rendered = await ImageManipulator.manipulate(uri).renderAsync();
        return { width: rendered.width, height: rendered.height };
      },
      async saveJpeg({ sourceUri, width, height, compress }) {
        const context = ImageManipulator.manipulate(sourceUri);
        const original = await context.renderAsync();
        const needsResize = original.width !== width || original.height !== height;
        const image = needsResize
          ? await context.reset().resize({ width, height }).renderAsync()
          : original;
        const saved = await image.saveAsync({
          compress,
          format: SaveFormat.JPEG,
        });
        return {
          uri: saved.uri,
          width: saved.width,
          height: saved.height,
          sizeBytes: await fileSize(saved.uri),
        };
      },
    });
    const durableUri = await persistPreparedChatJpeg(prepared.localUri);
    return { ...prepared, localUri: durableUri };
  } catch (err) {
    if (err instanceof TalkAIError) throw err;
    if (err instanceof RemoteChatImageError) {
      throw new TalkAIError('image_too_large', 'Remote image URLs are not allowed');
    }
    if (err instanceof ChatImageTooLargeError) {
      throw new TalkAIError('image_too_large');
    }
    throw new TalkAIError('image_too_large', 'Could not read image');
  }
}
