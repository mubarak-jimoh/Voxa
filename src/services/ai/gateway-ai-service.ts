import { createUuid } from '../../types';
import {
  AIActionIntentResult,
  AnalyzeConversationInput,
  ExtractedMemoryCandidate,
  GenerateCheckInInput,
  GenerateReplyInput,
  GenerateReplyResult,
  IAIService,
  SummarizeConversationInput,
  UnderstandActionIntentInput,
} from '../contracts';
import { CompanionModeId } from '../../types';
import { invokeAiGatewayChatOrThrow } from './ai-gateway-client';
import { buildGatewayChatMessagesWithDiagnostics } from './chat-message-builder';
import { FakeAIService } from './fake-ai-service';
import { uriToVisionDataUrl } from './image-data-url';

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 500;

/**
 * Routes core Talk completions through the Supabase ai-gateway edge function.
 * Non-talk IAIService methods delegate to offline/local fallbacks.
 */
export class GatewayAIService implements IAIService {
  private readonly offline = new FakeAIService();
  private readonly model: string;

  constructor(options?: { model?: string }) {
    this.model = options?.model ?? DEFAULT_MODEL;
  }

  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    return this.completeTalk(input);
  }

  async generateReplyStream(
    input: GenerateReplyInput,
    onChunk: (chunk: string) => void,
  ): Promise<GenerateReplyResult> {
    const result = await this.completeTalk(input);
    onChunk(result.content);
    return result;
  }

  generateCheckInPrompt(input: GenerateCheckInInput): Promise<string> {
    return this.offline.generateCheckInPrompt(input);
  }

  generateConversationTitle(mode: CompanionModeId, firstMessage: string): Promise<string> {
    return this.offline.generateConversationTitle(mode, firstMessage);
  }

  extractMemoriesFromExchange(input: AnalyzeConversationInput): Promise<ExtractedMemoryCandidate[]> {
    return this.offline.extractMemoriesFromExchange(input);
  }

  understandActionIntent(input: UnderstandActionIntentInput): Promise<AIActionIntentResult> {
    return (this.offline as IAIService).understandActionIntent(input);
  }

  summarizeConversation(input: SummarizeConversationInput): Promise<string> {
    return this.offline.summarizeConversation(input);
  }

  transcribeAudio(input: { uri: string; fileName?: string }): Promise<string | null> {
    return (this.offline as IAIService).transcribeAudio(input);
  }

  analyzeImage(input: { uri: string; mimeType?: string }): Promise<string | null> {
    return (this.offline as IAIService).analyzeImage(input);
  }

  private async completeTalk(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    let gatewayInput = input;
    if (input.imageUrlForVision) {
      const dataUrl = await uriToVisionDataUrl(input.imageUrlForVision);
      gatewayInput = { ...input, imageUrlForVision: dataUrl };
    }

    const { messages } = buildGatewayChatMessagesWithDiagnostics(gatewayInput);
    const idempotencyKey = createUuid();
    const result = await invokeAiGatewayChatOrThrow({
      messages,
      model: this.model,
      maxTokens: MAX_OUTPUT_TOKENS,
      metric: 'ai_messages',
      amount: 1,
      idempotencyKey,
      liveSearch: input.liveSearch === true,
    });

    const trimmed = result.content.trim();
    if (!trimmed) {
      throw new Error('AI gateway returned an empty response.');
    }
    return { content: trimmed, sourceLine: result.sourceLine };
  }
}
