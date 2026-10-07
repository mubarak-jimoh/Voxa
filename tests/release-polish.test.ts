import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatMemorySavedConfirmation } from '../src/services/actions/action-intent-parser';
import { classifyTalkIntent } from '../src/services/ai/companion-intent';
import { buildResponseQualityBlock } from '../src/services/ai/companion-response-quality';
import { classifyLiveInformationNeed, liveInformationSystemBlock } from '../src/services/ai/live-information';
import { buildVoxaSystemPrompt } from '../src/services/ai/voxa-system-prompt';
import {
  buildContextualSuggestions,
  replyIsWorthSummarising,
  userAskedForSummary,
} from '../src/services/chat/contextual-suggestions-service';
import { parseRichResponse } from '../src/services/phase6/rich-response-parser';
import { createDefaultCompanionIdentity } from '../src/constants/companion-identity';
import { createDefaultSubscription } from '../src/types/subscription';
import { createDefaultCompanionControls } from '../src/types/relationship-personality';
import { UserProfile } from '../src/types';

const PYTHON_Q = 'Explain what a Python function is in simple terms.';

const LONG_PYTHON_REPLY = [
  'A Python function is a named block of code you can run whenever you need that behaviour.',
  'You define it with def, give it a name, and optionally take inputs in the parentheses.',
  'When you call the function, Python jumps in, runs those lines, then comes back with any return value.',
  'That lets you reuse the same logic instead of copying the same code in five places.',
  'Keep functions small and named after what they do, so the rest of your program stays readable.',
].join(' ');

const SHORT_REPLY = 'A function is just a reusable block of code.';

function profile(): UserProfile {
  return {
    id: 'user-1',
    displayName: 'Alex',
    timezone: 'Europe/London',
    onboardingComplete: true,
    preferences: {
      voicePersonality: 'warm_calm',
      memoryEnabled: true,
      checkInStyle: 'gentle',
      proactiveVoiceCalls: false,
      hapticsEnabled: true,
      ambientGlowEnabled: true,
      selectedVoiceOptionId: 'aurora',
      companionControls: createDefaultCompanionControls(),
    },
    companion: { defaultMode: 'friend', lastUsedMode: 'friend' },
    companionIdentity: createDefaultCompanionIdentity(),
    subscription: createDefaultSubscription(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('V1 release polish', () => {
  it('does not auto-attach a Summary card after a normal long reply', () => {
    const rich = parseRichResponse(LONG_PYTHON_REPLY);
    assert.equal(rich.blocks.some((block) => block.kind === 'summary'), false);
    assert.ok(rich.text.includes('Python function'));
  });

  it('offers Summarise only after a longer reply, and the chip is an explicit user request', () => {
    assert.equal(replyIsWorthSummarising(SHORT_REPLY, PYTHON_Q), false);
    assert.equal(replyIsWorthSummarising(LONG_PYTHON_REPLY, PYTHON_Q), true);

    const shortChips = buildContextualSuggestions({
      talkIntent: 'unknown',
      userMessage: PYTHON_Q,
      voxaReply: SHORT_REPLY,
      stance: 'coach',
    });
    assert.ok(!shortChips.some((chip) => /summarise/i.test(chip.label)));
    assert.ok(!shortChips.some((chip) => /plan for this|prioritise these/i.test(chip.label)));

    const longChips = buildContextualSuggestions({
      talkIntent: 'unknown',
      userMessage: PYTHON_Q,
      voxaReply: LONG_PYTHON_REPLY,
      stance: 'coach',
    });
    const summarise = longChips.find((chip) => /summarise/i.test(chip.label));
    assert.ok(summarise);
    assert.equal(userAskedForSummary(summarise!.prompt), true);
    assert.ok(!longChips.some((chip) => /plan for this|prioritise these/i.test(chip.label)));
  });

  it('does not offer Summarise on short casual replies', () => {
    const chips = buildContextualSuggestions({
      talkIntent: 'casual_conversation',
      userMessage: 'yo',
      voxaReply: 'Hey.',
      stance: 'play',
    });
    assert.ok(!chips.some((chip) => /summarise/i.test(chip.label)));
  });

  it('keeps planning chips when the user is actually planning', () => {
    const chips = buildContextualSuggestions({
      talkIntent: 'planning',
      userMessage: 'Help me organise today',
      voxaReply: 'Here is a sequence.',
      stance: 'plan',
    });
    assert.ok(chips.some((chip) => /Make me a plan/i.test(chip.label)));
  });

  it('routes a university social question through normal companion Talk', () => {
    const message =
      "I've just started uni and haven't made any friends. I see someone from my lecture sitting alone. What should I say?";
    assert.equal(classifyLiveInformationNeed(message), 'none');
    const intent = classifyTalkIntent(message).intent;
    assert.ok(intent !== 'factual_question' && intent !== 'app_action_request');

    const quality = buildResponseQualityBlock(intent, false);
    assert.match(quality, /not a specialist student bot/i);
    assert.match(quality, /Do not claim university systems/i);

    const prompt = buildVoxaSystemPrompt({
      userProfile: profile(),
      mode: 'friend',
      memories: [],
    });
    assert.match(prompt, /Do not claim access to university systems/i);
    assert.doesNotMatch(prompt, /student records? (API|portal)/i);

    const chips = buildContextualSuggestions({
      talkIntent: intent,
      userMessage: message,
      voxaReply: 'Walk over, smile, and try: "Hey — you in the same lecture? I am still finding my feet."',
      stance: 'support',
    });
    assert.ok(!chips.some((chip) => /plan for this|prioritise these/i.test(chip.label)));
  });

  it('keeps live answers concise and bans dumps in presentation rules', () => {
    const block = liveInformationSystemBlock({
      timeZone: 'Europe/London',
      nowIso: '2026-10-07T12:00:00.000Z',
    });
    assert.match(block, /direct answer first/i);
    assert.match(block, /at most three short supporting bullets/i);
    assert.match(block, /Do not paste the whole table/i);
    assert.match(block, /Never show JSON, tool-call text/i);
    assert.equal(classifyLiveInformationNeed("Who's top of the Premier League?"), 'public');
  });

  it('memory confirmation names the fact and never says that that', () => {
    assert.equal(
      formatMemorySavedConfirmation('My test colour is purple'),
      "Saved — I'll remember that my test colour is purple.",
    );
    assert.equal(
      formatMemorySavedConfirmation('My lucky number is 17'),
      "Saved — I'll remember that my lucky number is 17.",
    );
    assert.doesNotMatch(formatMemorySavedConfirmation('My test colour is purple'), /that that/i);
    assert.equal(formatMemorySavedConfirmation('that'), "Saved — I'll remember that.");
  });
});
