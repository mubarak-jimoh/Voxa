import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseChatMarkdownBlocks, splitBoldSegments, visibleMarkdownText } from '../src/components/phase11/chat-markdown';
import {
  classifyLiveInformationNeed,
  extractWeatherPlace,
  liveInformationSystemBlock,
  resolveLiveInformationPlan,
  WEATHER_ASK_CITY_USER_LINE,
} from '../src/services/ai/live-information';
import { resolveRelativeDateWindow } from '../src/services/ai/relative-calendar';
import { sanitizeTalkDisplayText, talkDisplayContainsRawWebNoise } from '../src/services/chat/sanitize-talk-display';
import { weatherPromptIsGrounded } from '../src/services/weather/weather-ai-tool-service';

describe('release-candidate weather and live presentation', () => {
  it('extracts cities from natural weather phrasing', () => {
    assert.equal(extractWeatherPlace("What's the weather in London today?"), 'London');
    assert.equal(extractWeatherPlace('What is the weather like today in London'), 'London');
    assert.equal(extractWeatherPlace('Weather today in Manchester'), 'Manchester');
    const london = resolveLiveInformationPlan({
      userMessage: 'What is the weather like today in London',
    });
    assert.equal(london.askForWeatherCity, false);
    assert.equal(london.weatherPlaceQuery, 'London');
  });

  it('asks for a city when weather has no place, then continues on the city reply', () => {
    const ask = resolveLiveInformationPlan({ userMessage: "What's the weather like today?" });
    assert.equal(ask.askForWeatherCity, true);
    assert.equal(WEATHER_ASK_CITY_USER_LINE, 'Sure — what city are you in?');
    const follow = resolveLiveInformationPlan({
      userMessage: 'London',
      previousAssistantText: WEATHER_ASK_CITY_USER_LINE,
    });
    assert.equal(follow.kind, 'weather');
    assert.equal(follow.weatherPlaceQuery, 'London');
  });

  it('does not treat ungrounded weather copy as live measurements', () => {
    assert.equal(weatherPromptIsGrounded('I cannot access real-time weather.'), false);
    assert.ok(weatherPromptIsGrounded('Rule: Answer ONLY using this data. Never invent weather.'));
  });

  it('strips raw markdown links, URLs, openai utm params, and leftover bold markers', () => {
    const raw =
      '([football365.com](https://www.football365.com/story?utm_source=openai))\n**Floyd Schofield vs. Lucas Bahdi**\n## Card\n- one';
    const clean = sanitizeTalkDisplayText(raw);
    assert.equal(talkDisplayContainsRawWebNoise(clean), false);
    assert.doesNotMatch(clean, /\*\*/);
    assert.doesNotMatch(clean, /##/);
    assert.doesNotMatch(clean, /https?:\/\//i);
    assert.doesNotMatch(clean, /utm_source=openai/i);
    assert.match(clean, /Floyd Schofield vs\. Lucas Bahdi/);
    const bullets = parseChatMarkdownBlocks(clean);
    assert.ok(bullets.some((block) => block.type === 'bullets' || block.type === 'paragraph'));
    assert.equal(visibleMarkdownText('**Title**').includes('**'), false);
    assert.deepEqual(splitBoldSegments('**Title**'), [{ text: 'Title', bold: true }]);
  });

  it('resolves this weekend as Saturday–Sunday in Europe/London, excluding Thursday', () => {
    const window = resolveRelativeDateWindow(new Date('2026-10-07T12:00:00.000Z'), 'Europe/London');
    assert.match(window.today, /Wednesday.*7.*October.*2026/i);
    assert.match(window.tomorrow, /Thursday.*8.*October.*2026/i);
    assert.match(window.thisWeekend.start, /Saturday.*10.*October.*2026/i);
    assert.match(window.thisWeekend.end, /Sunday.*11.*October.*2026/i);
    assert.doesNotMatch(window.thisWeekend.start, /Thursday/);
    assert.doesNotMatch(window.thisWeekend.end, /Thursday/);
    assert.match(window.nextWeekend.start, /Saturday.*17.*October.*2026/i);
  });

  it('puts local calendar bounds and timezone rules into live-search context', () => {
    const block = liveInformationSystemBlock({
      timeZone: 'Europe/London',
      nowIso: '2026-10-07T12:00:00.000Z',
    });
    assert.match(block, /Saturday.*10.*October.*2026/i);
    assert.match(block, /Sunday.*11.*October.*2026/i);
    assert.match(block, /Do not include Thursday or Friday/);
    assert.match(block, /Do not also list PDT, PST/);
    assert.match(block, /at most three short supporting bullets/);
    assert.match(block, /tracking parameters/);
    assert.doesNotMatch(block, /https?:\/\//i);
  });

  it('keeps sports, news, and boxing on live search and skips ordinary Talk', () => {
    for (const message of [
      "Who's first on the PL table?",
      'Who is Arsenal playing next and when?',
      'What major boxing fights are happening this weekend?',
      'What are the latest major news stories today?',
    ]) {
      assert.equal(resolveLiveInformationPlan({ userMessage: message }).liveSearch, true, message);
    }
    assert.equal(resolveLiveInformationPlan({ userMessage: 'Help me plan my evening' }).liveSearch, false);
    assert.equal(
      resolveLiveInformationPlan({ userMessage: 'Remember my favourite colour is orange' }).liveSearch,
      false,
    );
  });

  it('sends postcode distance questions to live search instead of guessing', () => {
    const message = 'How far is SE61QE from SE61UA';
    assert.equal(classifyLiveInformationNeed(message), 'public');
    const block = liveInformationSystemBlock({
      timeZone: 'Europe/London',
      nowIso: '2026-10-07T12:00:00.000Z',
    });
    assert.match(block, /could not verify the exact distance/);
    assert.match(block, /Do not present straight-line distance as walking or driving time/);
  });

  it('does not rebuild live search or touch vision / eas in this cleanup', () => {
    const gateway = readFileSync('supabase/functions/ai-gateway/index.ts', 'utf8');
    assert.match(gateway, /v1\/responses/);
    assert.match(gateway, /tool_choice: 'required'/);
    const visionFollowUp = readFileSync('src/services/ai/vision-follow-up.ts', 'utf8');
    assert.match(visionFollowUp, /resolveImageUrlForVision/);
    const eas = readFileSync('eas.json', 'utf8');
    assert.match(eas, /"production"/);
    assert.doesNotMatch(readFileSync('src/services/ai/live-information.ts', 'utf8'), /14°C/);
  });
});
