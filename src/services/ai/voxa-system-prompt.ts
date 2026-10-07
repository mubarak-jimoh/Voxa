import { AI_GATEWAY_BUDGETS } from '../../config/ai-gateway-budgets';
import { COMPANION_MODES } from '../../constants/companion-modes';
import { personalityStylePromptBlock } from '../../constants/companion-identity';
import { VOXA_SAFETY } from '../../constants/safety';
import { buildOnboardingReasonContext } from '../../config/onboarding-flow';
import { CompanionModeId, Goal, Memory, Reminder, UserProfile } from '../../types';
import {
  TalkIntent,
  intentWantsGoals,
  intentWantsMemories,
  intentWantsReminders,
} from './companion-intent';
import { buildResponseQualityBlock } from './companion-response-quality';
import { buildHumanStyleExtension } from '../personality/human-response-style';
import {
  confidenceKindForPrompt,
  memoryConfidenceKind,
  resolveCompanionMemoryType,
} from '../memory/memory-taxonomy';
import { decideMemoryCallback, countTemporalAlignments, memoryTemporallyAligns } from '../memory/memory-callback-gate';
import { formatActiveEventForPrompt, joinOpenLoops } from '../memory/open-loop-service';
import { overlapScore, tokenize } from '../memory/memory-relevance';
import { parseUserTemporal, readTemporalMeta } from '../memory/temporal-memory';
import { resolveDeviceTimeZone } from '../memory/temporal-parse';
import { resolveMemoryPolicy, TURN_INTELLIGENCE_END } from './turn-intelligence-plan';
import { liveInformationSystemBlock } from './live-information';

const MAX_MEMORIES_IN_PROMPT = AI_GATEWAY_BUDGETS.maxMemoriesInPrompt;

/** Positive vision rules. Naming inability-to-see in the prompt primes hedge replies. */
export const ATTACHED_PHOTO_GUIDANCE = [
  '## Attached photo',
  'A photo is attached to this message. You can see it. Answer from that photo. Describe visible objects, colours, layout, and setting.',
  'If printed or on-screen writing is too small to read, describe the rest of the scene first, then say that the smaller writing is unreadable. Do not invent the unread words.',
  'If a person appears, describe the visible scene and clothing. Do not guess their name.',
  'Start from what is visible. Do not open by denying that the photo is visible.',
].join('\n');

const ATTACHED_PHOTO_TURN_AUTHORITY =
  'Photo on this turn: you can see it. Describe what is visible. Unreadable writing is not a missing photo. Do not guess a person\'s name.';

/** Place photo rules inside turn intelligence so later "authoritative" notes cannot override them. */
export function applyAttachedPhotoTurnAuthority(
  turnBlock: string,
  hasAttachedImage: boolean,
): string {
  if (!hasAttachedImage) return turnBlock;
  if (!turnBlock.trim()) return ATTACHED_PHOTO_TURN_AUTHORITY;
  const end = turnBlock.indexOf(TURN_INTELLIGENCE_END);
  if (end < 0) return `${turnBlock.trim()}\n${ATTACHED_PHOTO_TURN_AUTHORITY}`;
  return `${turnBlock.slice(0, end)}${ATTACHED_PHOTO_TURN_AUTHORITY}\n${turnBlock.slice(end)}`;
}

const MEMORY_TRUST_BLOCK = `
## Memory trust levels
- EXPLICIT USER FACT: said directly in this conversation.
- STORED MEMORY: listed below — use naturally; never say "you told me", "you previously told me", or "according to my memory".
- SHORT-TERM CONTEXT: recent chat turns — use for follow-ups like "it", "that", "the second one".
- INFERENCE: never present as memory. If nothing relevant is stored, say you do not have that saved.
- callback=mention: you may reference it if it genuinely helps.
- callback=use_silently: use only to understand; do not mention it unless the user brings it up.
- If temporal confidence is not high, do not make a strong callback.
- If an Active event is listed, treat it as current context and speak naturally. Never say "you previously told me" or "according to my memory".
- If no Active event is listed, do not guess which event the user means.
- Do not invent memories or guess which event the user means.
- You are AI. Be familiar with stored preferences. Do not claim human attachment, missing the user, waiting to hear from them, or shared emotional history you do not have.
`.trim();

export function buildVoxaSystemPrompt(input: {
  userProfile: UserProfile;
  mode: CompanionModeId;
  memories: Memory[];
  goals?: Goal[];
  upcomingReminders?: Reminder[];
  currentTime?: string;
  companionContextExtension?: string;
  turnIntelligenceBlock?: string;
  talkIntent?: TalkIntent;
  referencesRecentTurns?: boolean;
  conversationState?: import('./companion-strategy').ConversationState;
  userMessage?: string;
  /** True only when this Talk turn includes a validated image_url part. */
  hasAttachedImage?: boolean;
  liveSearch?: boolean;
  liveSearchLocationLabel?: string;
}): string {
  const mode = COMPANION_MODES[input.mode];
  const intent = input.talkIntent ?? 'unknown';
  const includeMemories = intentWantsMemories(intent) && input.memories.length > 0;
  const includeGoals = intentWantsGoals(intent);
  const includeReminders = intentWantsReminders(intent);

  const recentMemories = includeMemories ? input.memories.slice(0, MAX_MEMORIES_IN_PROMPT) : [];
  const activeGoals = includeGoals
    ? (input.goals ?? []).filter((item) => item.status === 'active').slice(0, AI_GATEWAY_BUDGETS.maxGoalsInPrompt)
    : [];
  const upcoming = includeReminders
    ? (input.upcomingReminders ?? []).slice(0, AI_GATEWAY_BUDGETS.maxRemindersInPrompt)
    : [];
  const now = input.currentTime ?? new Date().toISOString();

  const memoryBlock = includeMemories
    ? recentMemories.length > 0
      ? formatMemoriesForPrompt({
          memories: recentMemories,
          userMessage: input.userMessage,
          talkIntent: intent,
          timeZone: input.userProfile.timezone,
          nowIso: now,
        })
      : '- No relevant stored memories for this message.'
    : '';

  const goalsBlock = includeGoals
    ? activeGoals.length > 0
      ? activeGoals.map((item) => `- ${item.title} (${item.progress}% · ${item.category})`).join('\n')
      : ''
    : '';

  const remindersBlock = includeReminders
    ? upcoming.length > 0
      ? upcoming.map((item) => `- ${item.title} at ${new Date(item.scheduledAt).toLocaleString()}`).join('\n')
      : ''
    : '';

  return [
    'You are Voxa, a premium AI life companion inside a mobile app.',
    'Be warm, conversational, observant, and useful — not a generic chatbot.',
    'You are AI. Be honest about that if asked, without being cold.',
    '',
    '## Safety (always follow — overrides all other context)',
    `- You are NOT a licensed therapist, doctor, counselor, or emergency service. ${VOXA_SAFETY.notTherapist}`,
    `- ${VOXA_SAFETY.notEmergency}`,
    '- If someone mentions self-harm, abuse, or immediate danger, respond with compassion and urge them to contact local emergency services or a trusted person right now.',
    '',
    input.hasAttachedImage
      ? `${ATTACHED_PHOTO_GUIDANCE}\n`
      : 'This turn has no attached photo. Answer the text using conversation and stored memories where relevant.',
    input.liveSearch
      ? `${liveInformationSystemBlock({
          timeZone: input.userProfile.timezone,
          nowIso: now,
          locationLabel: input.liveSearchLocationLabel,
        })}\n`
      : '',
    applyAttachedPhotoTurnAuthority(
      input.turnIntelligenceBlock?.trim() ?? '',
      Boolean(input.hasAttachedImage),
    ),
    '',
    buildResponseQualityBlock(intent, input.referencesRecentTurns ?? false, input.conversationState),
    '',
    '## Active mode',
    `Mode: ${mode.label} · Tone: ${mode.tone}`,
    `Helps with: ${mode.helpsWith.join(', ')}`,
    '',
    '## User',
    `Name: ${input.userProfile.displayName}`,
    `Timezone: ${input.userProfile.timezone}`,
    `Current time: ${now}`,
    `Companion name: ${input.userProfile.companionIdentity?.voxaName ?? 'Voxa'}`,
    personalityStylePromptBlock(input.userProfile.companionIdentity?.personalityStyle),
    (() => {
      const helpReasons = buildOnboardingReasonContext({
        mainReason: input.userProfile.mainReason,
        goalInterests: input.userProfile.onboarding?.goalInterests,
      });
      if (helpReasons.length === 0) return '';
      if (helpReasons.length === 1) return `Main reason for Voxa: ${helpReasons[0]}`;
      return `What they want help with: ${helpReasons.join('; ')} (primary: ${helpReasons[0]})`;
    })(),
    includeMemories ? `\n${MEMORY_TRUST_BLOCK}` : '',
    includeMemories ? '\n## Relevant memories\n' + memoryBlock : '',
    includeGoals && goalsBlock ? `\n## Active goals\n${goalsBlock}` : '',
    includeReminders && remindersBlock ? `\n## Upcoming reminders\n${remindersBlock}` : '',
    '',
    '## Everyday life',
    '- Help with ordinary life, including university, work, and home, as the same companion — not a specialist student bot.',
    '- For making friends, approaching someone, settling in, loneliness, societies, group work, study, or deadlines: give practical, human advice and a realistic thing they could actually say or do.',
    '- Do not claim access to university systems, timetables, student records, or live campus information unless it was supplied or retrieved this turn.',
    '- Do not sound like a corporate coach.',
    '',
    '## Notes privacy',
    '- User notes are private by default. Never claim you read a note unless its content was attached in this conversation or the user explicitly shared it.',
    '- Do not invent note contents.',
    '',
    buildHumanStyleExtension(),
    input.companionContextExtension ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatMemoriesForPrompt(input: {
  memories: Memory[];
  userMessage?: string;
  talkIntent: TalkIntent;
  timeZone?: string;
  nowIso: string;
}): string {
  const timeZone = resolveDeviceTimeZone(input.timeZone);
  const now = new Date(input.nowIso);
  const policy = resolveMemoryPolicy(input.talkIntent);
  const queryTemporal = input.userMessage ? parseUserTemporal(input.userMessage, now, timeZone) : null;
  const join = joinOpenLoops(input.memories, {
    userMessage: input.userMessage ?? '',
    now,
    timeZone,
  });
  const alignCount = join.ambiguous
    ? join.competing.length
    : countTemporalAlignments(input.memories, queryTemporal, timeZone);

  const lines: string[] = [];
  for (const memory of input.memories) {
    const keywordOverlap = input.userMessage
      ? overlapScore(tokenize(input.userMessage), `${memory.title} ${memory.content}`)
      : 0;
    const callback = input.userMessage
      ? decideMemoryCallback({
          memory,
          userMessage: input.userMessage,
          intent: input.talkIntent,
          memoryPolicy: policy,
          now,
          timeZone,
          queryTemporal,
          keywordOverlap,
          temporalAlign: memoryTemporallyAligns(memory, queryTemporal, timeZone),
          ambiguousTemporalMatch: join.ambiguous || Boolean(queryTemporal && alignCount > 1 && keywordOverlap < 0.2),
          uniqueOpenLoop: join.unique && join.memory?.id === memory.id,
        })
      : 'use_silently';
    if (callback === 'ignore') continue;
    if (join.unique && join.memory?.id === memory.id && (callback === 'mention' || callback === 'use_silently')) {
      lines.push(formatActiveEventForPrompt({ memory, callback, timeZone }));
    }
    const trust = confidenceKindForPrompt(memoryConfidenceKind(memory));
    const type = resolveCompanionMemoryType(memory.category, memory.tags);
    const meta = readTemporalMeta(memory, timeZone);
    const when = meta.label ? ` · ${meta.label}` : '';
    lines.push(
      `- [${trust}] ${memory.title} (${type}): ${memory.content.slice(0, 120)}${when} · callback=${callback}`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : '- No relevant stored memories for this message.';
}
