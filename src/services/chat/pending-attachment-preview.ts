import { PendingAttachmentInput } from '../../types';

/** User-facing tray label — never a UUID, cache path, or internal file name. */
export function pendingAttachmentPreviewLabel(item: PendingAttachmentInput): string {
  if (item.type === 'audio') return 'Voice note ready';
  if (item.type === 'image') return 'Photo';
  if (item.type === 'video') return 'Video';
  return 'Attachment';
}
