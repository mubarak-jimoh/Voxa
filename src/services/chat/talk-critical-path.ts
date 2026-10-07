import { TalkIntent, intentWantsMemories } from '../ai/companion-intent';
import { ChatMessageView, CompanionModeId, Message, nowIso } from '../../types';

/** Deterministic: factual and app-action turns never inject memories. */
export function talkIntentSkipsMemoryRetrieval(intent: TalkIntent): boolean {
  return !intentWantsMemories(intent);
}

export function chatViewsToHistory(
  views: ChatMessageView[],
  conversationId: string,
  mode: CompanionModeId,
): Message[] {
  return views
    .filter((view) => view.status !== 'pending' && view.status !== 'failed')
    .map((view) => ({
      id: view.id,
      conversationId,
      role: view.role,
      content: view.text,
      mode,
      createdAt: view.createdAt,
      status: view.status ?? 'sent',
      attachments: view.attachments,
    }));
}

export function buildLocalTalkMessage(input: {
  id: string;
  conversationId: string;
  role: Message['role'];
  content: string;
  mode: CompanionModeId;
  attachments?: Message['attachments'];
  metadata?: Message['metadata'];
}): Message {
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    mode: input.mode,
    createdAt: nowIso(),
    status: 'sent',
    attachments: input.attachments,
    metadata: input.metadata,
  };
}
