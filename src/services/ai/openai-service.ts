import { CompanionModeId, GoalCategory, Memory, MemoryCategory, MemoryMood } from '../../types';
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
import { MEMORY_EXTRACTION_CATEGORIES } from '../../constants/memory-categories';
import { extractMemoriesLocally } from '../memory/local-memory-extractor';
import { buildVoxaSystemPrompt } from './voxa-system-prompt';
import { IMAGE_TURN_VISION_INSTRUCTION, mapConversationHistory } from './gateway-context-budget';
import { uriToVisionDataUrl } from './image-data-url';
import { stripVisionPlaceholdersFromUserText } from './vision-follow-up';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'gpt-4o-mini';

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentPart[];
};

type OpenAIServiceOptions = {
  apiKey: string;
  model?: string;
};

export class OpenAIService implements IAIService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: OpenAIServiceOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    const messages = await this.buildChatMessages(input);

    const content = await this.completeChat(messages, {
      temperature: 0.8,
      maxTokens: 500,
    });

    return {
      content,
    };
  }

  async generateReplyStream(
    input: GenerateReplyInput,
    onChunk: (chunk: string) => void,
  ): Promise<GenerateReplyResult> {
    const messages = await this.buildChatMessages(input);

    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.8,
        max_tokens: 500,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI stream failed (${response.status}): ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      console.warn('[Voxa] OpenAI streaming unavailable — falling back to non-streaming completion.');
      const result = await this.generateReply(input);
      onChunk(result.content);
      return result;
    }

    const decoder = new TextDecoder();
    let content = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onChunk(delta);
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }

    if (!content.trim()) {
      console.warn('[Voxa] OpenAI empty stream — falling back to non-streaming completion.');
      return this.generateReply(input);
    }

    return { content: content.trim() };
  }

  async generateCheckInPrompt(input: GenerateCheckInInput): Promise<string> {
    const systemPrompt = buildVoxaSystemPrompt({
      userProfile: input.userProfile,
      mode: input.mode,
      memories: input.memories,
    });

    const userPrompt = input.reminder.body
      ? `Write a short, warm check-in opener for the reminder "${input.reminder.title}". Context: ${input.reminder.body}`
      : `Write a short, warm check-in opener for the reminder "${input.reminder.title}".`;

    return this.completeChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.7, maxTokens: 120 },
    );
  }

  async generateConversationTitle(mode: CompanionModeId, firstMessage: string): Promise<string> {
    const snippet = firstMessage.trim().slice(0, 42);
    const content = await this.completeChat(
      [
        {
          role: 'system',
          content:
            'Generate a short conversation title (max 6 words). Return only the title, no quotes.',
        },
        {
          role: 'user',
          content: `Mode: ${mode}. First message: ${firstMessage}`,
        },
      ],
      { temperature: 0.5, maxTokens: 24 },
    );

    return content || `${mode.replace('_', ' ')} · ${snippet}${firstMessage.length > 42 ? '…' : ''}`;
  }

  async extractMemoriesFromExchange(input: AnalyzeConversationInput): Promise<ExtractedMemoryCandidate[]> {
    try {
      const categories = MEMORY_EXTRACTION_CATEGORIES.join(', ');
      const raw = await this.completeChat(
        [
          {
            role: 'system',
            content: [
              'Extract durable long-term memories about the user from this chat exchange.',
              `Valid categories: ${categories}.`,
              'Return ONLY a JSON array (max 3 items). Each item:',
              '{ "category": string, "title": string, "content": string, "importance": 1-5, "tags": string[], "mood": "motivated"|"warm"|"joyful"|"calm"|"reflective"|"stressed"|"neutral" }',
              'Skip small talk, greetings, and transient feelings. Merge with existing memories mentally — prefer updates over duplicates.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              userMessage: input.userMessage,
              voxaReply: input.voxaReply,
              mode: input.mode,
              existingTitles: input.existingMemories.slice(0, 12).map((item) => item.title),
            }),
          },
        ],
        { temperature: 0.2, maxTokens: 500 },
      );

      return parseExtractedMemories(raw, input.mode);
    } catch (error) {
      console.warn('[Voxa] OpenAI memory extraction failed, using local rules.', error);
      return extractMemoriesLocally({
        userMessage: input.userMessage,
        voxaReply: input.voxaReply,
        mode: input.mode,
        existingMemories: input.existingMemories,
        writeContext: {
          now: new Date(),
          timeZone: input.userProfile.timezone,
        },
      });
    }
  }

  async understandActionIntent(input: UnderstandActionIntentInput): Promise<AIActionIntentResult> {
    try {
      const raw = await this.completeChat(
        [
          {
            role: 'system',
            content: [
              'Parse the user message for a reminder or goal intent.',
              'Return ONLY JSON:',
              '{ "action": "set_reminder"|"create_goal"|"none", "title"?: string, "scheduledAt"?: ISO8601, "category"?: "fitness"|"study"|"business"|"productivity"|"emotional"|"money"|"general" }',
              'Use set_reminder when they want to be reminded at a time.',
              'Use create_goal when they express a goal to track.',
              'Use none for normal chat.',
              `Current time: ${input.currentTime ?? new Date().toISOString()}`,
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              message: input.message,
              mode: input.mode,
              activeGoals: input.activeGoals?.slice(0, 5).map((g) => g.title),
              upcomingReminders: input.upcomingReminders?.slice(0, 3).map((r) => r.title),
            }),
          },
        ],
        { temperature: 0.1, maxTokens: 200 },
      );

      return parseActionIntent(raw);
    } catch {
      return { action: 'none' };
    }
  }

  async transcribeAudio(input: { uri: string; fileName?: string }): Promise<string | null> {
    const formData = new FormData();
    formData.append('file', {
      uri: input.uri,
      name: input.fileName ?? 'voice-note.m4a',
      type: 'audio/m4a',
    } as unknown as Blob);
    formData.append('model', 'whisper-1');

    const response = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI transcription failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as { text?: string };
    return data.text?.trim() ?? null;
  }

  async analyzeImage(input: { uri: string; mimeType?: string }): Promise<string | null> {
    const dataUrl = await uriToDataUrl(input.uri);
    const content = await this.completeChat(
      [
        {
          role: 'system',
          content:
            'Describe this image briefly for a companion app. Focus on what the user might want to discuss. 1-2 sentences.',
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: dataUrl } }],
        },
      ],
      { temperature: 0.4, maxTokens: 120 },
    );
    return content.trim() || null;
  }

  async summarizeConversation(input: SummarizeConversationInput): Promise<string> {
    const transcript = input.messages
      .filter((item) => item.role !== 'system')
      .slice(-24)
      .map((item) => `${item.role}: ${item.content}`)
      .join('\n');

    return this.completeChat(
      [
        {
          role: 'system',
          content:
            'Summarize this conversation in 2-3 warm, concise sentences for the user. Focus on themes, feelings, and next steps. No bullet lists.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            user: input.userProfile.displayName,
            mode: input.mode,
            goals: input.goals?.slice(0, 3).map((g) => g.title),
            reminders: input.upcomingReminders?.slice(0, 3).map((r) => r.title),
            currentTime: input.currentTime ?? new Date().toISOString(),
            transcript,
          }),
        },
      ],
      { temperature: 0.5, maxTokens: 180 },
    );
  }

  private async buildChatMessages(input: GenerateReplyInput): Promise<OpenAIChatMessage[]> {
    const systemPrompt = buildVoxaSystemPrompt({
      userProfile: input.userProfile,
      mode: input.mode,
      memories: input.memories,
      goals: input.goals,
      upcomingReminders: input.upcomingReminders,
      currentTime: input.currentTime ?? new Date().toISOString(),
      companionContextExtension: input.companionContextExtension,
      turnIntelligenceBlock: input.turnIntelligenceBlock,
      talkIntent: input.talkIntent,
      referencesRecentTurns: input.referencesRecentTurns,
      conversationState: input.conversationState,
      userMessage: input.userMessage,
      hasAttachedImage: Boolean(input.imageUrlForVision),
      liveSearch: input.liveSearch === true,
      liveSearchLocationLabel: input.liveSearchLocationLabel,
    });

    const history = mapConversationHistory(input.conversationHistory);
    if (history.length > 0 && history[history.length - 1].role === 'user') {
      history.pop();
    }

    const userTurn = await this.buildUserTurn(input);
    return [{ role: 'system', content: systemPrompt }, ...history, userTurn];
  }

  private async buildUserTurn(input: GenerateReplyInput): Promise<OpenAIChatMessage> {
    let text = input.userMessage.trim();

    if (input.imageUrlForVision) {
      const dataUrl = await uriToDataUrl(input.imageUrlForVision);
      const caption = stripVisionPlaceholdersFromUserText(text) || 'What do you see in this image?';
      return {
        role: 'user',
        content: [
          { type: 'text', text: `${caption}\n\n${IMAGE_TURN_VISION_INSTRUCTION}` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      };
    }

    if (input.imageAnalysisSummary && !text.includes('[Photo]')) {
      text = [text, `[Photo context: ${input.imageAnalysisSummary}]`].filter(Boolean).join('\n');
    }

    return { role: 'user', content: text };
  }

  private async completeChat(
    messages: OpenAIChatMessage[],
    options: { temperature: number; maxTokens: number },
  ): Promise<string> {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('OpenAI returned an empty response.');
    }

    return content;
  }
}

async function uriToDataUrl(uri: string): Promise<string> {
  // Direct OpenAI client (dev only) may already have a data URL or remote URL.
  if (uri.startsWith('data:') || uri.startsWith('http')) return uri;
  return uriToVisionDataUrl(uri);
}

const VALID_MOODS: MemoryMood[] = [
  'motivated',
  'warm',
  'joyful',
  'calm',
  'reflective',
  'stressed',
  'neutral',
];

function parseExtractedMemories(raw: string, mode: CompanionModeId): ExtractedMemoryCandidate[] {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item): ExtractedMemoryCandidate | null => {
      const category = item.category as MemoryCategory;
      if (!MEMORY_EXTRACTION_CATEGORIES.includes(category)) return null;

      const title = String(item.title ?? '').trim();
      const content = String(item.content ?? '').trim();
      if (!title || !content) return null;

      const importanceRaw = Number(item.importance);
      const importance = (
        importanceRaw >= 1 && importanceRaw <= 5 ? importanceRaw : 3
      ) as Memory['importance'];
      const mood = VALID_MOODS.includes(item.mood as MemoryMood)
        ? (item.mood as MemoryMood)
        : 'neutral';

      return {
        category,
        title,
        content,
        importance,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        mood,
        relatedMode: mode,
      };
    })
    .filter((item): item is ExtractedMemoryCandidate => item !== null)
    .slice(0, 3);
}

const VALID_GOAL_CATEGORIES: GoalCategory[] = [
  'fitness',
  'study',
  'business',
  'productivity',
  'emotional',
  'money',
  'general',
];

function parseActionIntent(raw: string): AIActionIntentResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { action: 'none' };

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const action = String(parsed.action ?? 'none');

  if (action === 'set_reminder') {
    const title = String(parsed.title ?? '').trim();
    const scheduledAt = String(parsed.scheduledAt ?? '').trim();
    if (!title || !scheduledAt) return { action: 'none' };
    return { action: 'set_reminder', title, scheduledAt };
  }

  if (action === 'create_goal') {
    const title = String(parsed.title ?? '').trim();
    const categoryRaw = String(parsed.category ?? 'general') as GoalCategory;
    const category = VALID_GOAL_CATEGORIES.includes(categoryRaw) ? categoryRaw : 'general';
    if (!title) return { action: 'none' };
    return { action: 'create_goal', title, category };
  }

  return { action: 'none' };
}
