import { Message } from '../../types';

const PHOTO_QUESTION =
  /\b(this photo|this image|this picture|this pic|this screenshot|the photo|the image|the picture|the pic|the screenshot|what (do|can) (you|u) see|what('s| is) in (this|the) (photo|image|picture|pic|screenshot)|describe (this|the) (photo|image|picture|pic|screenshot)|look at (this|the) (photo|image|picture|pic|screenshot))\b/i;

export function messageRefersToAttachedPhoto(text: string): boolean {
  return PHOTO_QUESTION.test(text.trim());
}

export function lastLocalImageUriFromHistory(history: Message[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== 'user') continue;
    const image = message.attachments?.find(
      (item) => item.type === 'image' && Boolean(item.localUri?.trim()),
    );
    if (image?.localUri?.trim()) return image.localUri.trim();
  }
  return undefined;
}

/**
 * Current-turn images always win. Older photos are reused only when the user
 * clearly refers to the photo — never for ordinary memory or live questions.
 */
export function resolveImageUrlForVision(input: {
  currentTurnUri?: string;
  userMessage: string;
  history: Message[];
}): string | undefined {
  const current = input.currentTurnUri?.trim();
  if (current) return current;

  if (!messageRefersToAttachedPhoto(input.userMessage)) return undefined;
  return lastLocalImageUriFromHistory(input.history);
}

/** Remove textual photo stand-ins so the model uses the attached image, not a placeholder label. */
export function stripVisionPlaceholdersFromUserText(text: string): string {
  return text
    .replace(/^\s*\[Photo shared\]\s*$/gim, '')
    .replace(/^\s*\[Photo\]:.*$/gim, '')
    .replace(/^\s*\[Photo context:[^\]]*\]\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
