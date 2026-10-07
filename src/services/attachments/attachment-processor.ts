import { IAIService } from '../contracts';
import { recordPhotoAnalysisStatus } from '../../utils/chat-debug-state';
import {
  recordVoiceNoteTranscriptionStatus,
  recordVoiceNoteUploadStatus,
} from '../../utils/voice-note-debug-state';
import {
  MessageAttachment,
  MemorySource,
  PendingAttachmentInput,
  attachmentDisplayLabel,
} from '../../types';
import { attachmentStorageService } from './attachment-storage-service';

export type ProcessedAttachment = MessageAttachment;

export type AttachmentProcessResult = {
  attachments: ProcessedAttachment[];
  effectiveUserText: string;
  mediaSource: MemorySource;
  imageUrlForVision?: string;
  imageAnalysisSummary?: string;
};

export class AttachmentProcessor {
  constructor(private readonly ai: IAIService) {}

  async processPending(
    pending: PendingAttachmentInput[],
    userCaption: string,
  ): Promise<AttachmentProcessResult> {
    const attachments: ProcessedAttachment[] = [];
    const textParts: string[] = [];
    let mediaSource: MemorySource = 'text';
    let imageUrlForVision: string | undefined;
    let imageAnalysisSummary: string | undefined;

    for (const item of pending) {
      const base = attachmentStorageService.buildAttachment({
        type: item.type,
        localUri: item.localUri,
        mimeType: item.mimeType,
        fileName: item.fileName,
        sizeBytes: item.sizeBytes,
        durationSeconds: item.durationSeconds,
        thumbnailUri: item.thumbnailUri,
      });

      if (item.type === 'audio') {
        mediaSource = 'audio';
        let transcription: string | null = null;
        try {
          transcription = await this.ai.transcribeAudio({ uri: item.localUri, fileName: item.fileName });
          recordVoiceNoteTranscriptionStatus(transcription ? 'OK' : 'Empty');
        } catch (err) {
          console.warn('[Voxa] Audio transcription failed.', err);
          recordVoiceNoteTranscriptionStatus(err instanceof Error ? err.message : 'Failed');
        }
        attachments.push({
          ...base,
          transcription: transcription ?? undefined,
          analysisSummary: transcription ? undefined : 'Voice note saved',
        });
        textParts.push(
          transcription
            ? `[Voice note]: ${transcription}`
            : '[Voice note saved — transcription unavailable]',
        );
        continue;
      }

      if (item.type === 'image') {
        mediaSource = 'image';
        recordPhotoAnalysisStatus('OK');
        imageUrlForVision = item.localUri;
        imageAnalysisSummary = undefined;
        attachments.push({
          ...base,
          analysisSummary: 'Photo shared',
        });
        textParts.push('[Photo shared]');
        continue;
      }

      if (item.type === 'video') {
        mediaSource = 'video';
        const meta = item.fileName ?? 'Video';
        const duration = item.durationSeconds ? ` (${Math.round(item.durationSeconds)}s)` : '';
        attachments.push({
          ...base,
          analysisSummary: `Video: ${meta}${duration}`,
        });
        textParts.push(`[Video: ${meta}${duration}]`);
        continue;
      }

      attachments.push(base);
      textParts.push(`[File: ${item.fileName ?? 'attachment'}]`);
    }

    const caption = userCaption.trim();
    const effectiveUserText =
      [caption, ...textParts].filter(Boolean).join('\n').trim() ||
      attachments.map((a) => attachmentDisplayLabel(a)).join(' · ');

    return {
      attachments,
      effectiveUserText,
      mediaSource: attachments.length > 0 ? mediaSource : 'text',
      imageUrlForVision,
      imageAnalysisSummary,
    };
  }

  async uploadAll(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    attachments: MessageAttachment[];
  }): Promise<MessageAttachment[]> {
    const uploaded: MessageAttachment[] = [];
    for (const attachment of input.attachments) {
      const next = await attachmentStorageService.uploadAttachment({
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        attachment: { ...attachment, uploadStatus: 'uploading' },
      });
      uploaded.push(next);
      if (next.type === 'audio') {
        recordVoiceNoteUploadStatus(next.uploadStatus ?? 'unknown');
      }
    }
    return uploaded;
  }
}

export const createAttachmentProcessor = (ai: IAIService) => new AttachmentProcessor(ai);
