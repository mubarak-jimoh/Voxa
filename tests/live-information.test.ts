import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  classifyLeagueTableAsk,
  classifyLiveInformationNeed,
  extractWeatherPlace,
  isWeatherCityFollowUp,
  liveSearchShouldRun,
  minimizedLiveSearchQuestion,
  resolveLiveInformationPlan,
  shapeLivePublicAnswer,
  WEATHER_ASK_CITY_USER_LINE,
} from '../src/services/ai/live-information';
import { selectContextModules } from '../src/services/ai/companion-context-router';
import { weatherPromptIsGrounded } from '../src/services/weather/weather-ai-tool-service';
import { TalkAIError } from '../src/services/ai/talk-ai-errors';

describe('live information routing', () => {
  it('triggers public live search for current sports, news, and events', () => {
    const live = [
      "Who's top of the Premier League?",
      "Who's first on the PL table?",
      "Who's winning the Arsenal game?",
      'What games are on tonight?',
      "Who's boxing tomorrow?",
      "What's the latest news about X?",
      'What are the latest major news stories today?',
      'Who is Arsenal playing next?',
      'When is Fury fighting?',
      'Who won the game?',
      "What's happening today with Apple?",
    ];
    for (const message of live) {
      assert.equal(classifyLiveInformationNeed(message), 'public', message);
      assert.equal(resolveLiveInformationPlan({ userMessage: message }).liveSearch, true, message);
    }
  });

  it('classifies weather without searching when a city or saved location is available', () => {
    assert.equal(classifyLiveInformationNeed("What's the weather like today"), 'weather');
    assert.equal(liveSearchShouldRun('weather'), false);
    const ask = resolveLiveInformationPlan({ userMessage: "What's the weather like today" });
    assert.equal(ask.askForWeatherCity, true);
    assert.equal(ask.liveSearch, false);
    assert.equal(WEATHER_ASK_CITY_USER_LINE, 'Sure — what city are you in?');

    const london = resolveLiveInformationPlan({
      userMessage: "What's the weather today in London?",
    });
    assert.equal(london.askForWeatherCity, false);
    assert.equal(london.weatherPlaceQuery, 'London');
    assert.equal(london.liveSearch, false);

    const saved = resolveLiveInformationPlan({
      userMessage: "What's the weather like today",
      hasSavedWeatherLocation: true,
    });
    assert.equal(saved.askForWeatherCity, false);
    assert.equal(saved.liveSearch, false);
  });

  it('treats a city reply after the weather ask as a weather place, not a search skip', () => {
    assert.equal(
      isWeatherCityFollowUp('London', 'Sure — what city are you in?'),
      true,
    );
    const follow = resolveLiveInformationPlan({
      userMessage: 'London',
      previousAssistantText: 'Sure — what city are you in?',
    });
    assert.equal(follow.kind, 'weather');
    assert.equal(follow.weatherPlaceQuery, 'London');
    assert.equal(follow.askForWeatherCity, false);
  });

  it('extracts an explicit weather city and ignores weather-without-place', () => {
    assert.equal(extractWeatherPlace("What's the weather in London today?"), 'London');
    assert.equal(extractWeatherPlace('What is the weather like today in London'), 'London');
    assert.equal(extractWeatherPlace('Weather today in Manchester'), 'Manchester');
    assert.equal(extractWeatherPlace("What's the weather like today"), undefined);
  });

  it('does not search for ordinary companion requests', () => {
    const skip = [
      'Help me plan my evening',
      'Remember my favourite colour is orange',
      'Explain recursion',
      'Write me a study plan',
      'Who is Muhammad Ali?',
    ];
    for (const message of skip) {
      assert.equal(classifyLiveInformationNeed(message), 'none', message);
      assert.equal(resolveLiveInformationPlan({ userMessage: message }).liveSearch, false, message);
    }
  });

  it('does not put attachment placeholders into the live search question', () => {
    const question = minimizedLiveSearchQuestion("Who's top of the Premier League?\n[Photo shared]");
    assert.equal(question, "Who's top of the Premier League?");
  });

  it('includes weather context for factual weather questions', () => {
    const modules = selectContextModules('factual_question', "What's the weather today?");
    assert.ok(modules.includes('weather'));
    const math = selectContextModules('factual_question', "What's 17 x 8?");
    assert.ok(!math.includes('weather'));
  });

  it('treats ungrounded weather copy as not live data', () => {
    assert.equal(weatherPromptIsGrounded('No weather location is saved.'), false);
    assert.equal(
      weatherPromptIsGrounded('  Rule: Answer ONLY using this data. Never invent weather.'),
      true,
    );
  });

  it('maps live-search failure to a retryable user error without inventing facts', () => {
    const err = new TalkAIError('live_unavailable');
    assert.match(err.userMessage, /couldn't verify current information/i);
    assert.doesNotMatch(err.userMessage, /openai/i);
    assert.doesNotMatch(err.userMessage, /api key/i);
  });

  it('keeps live search on the server gateway Responses path', () => {
    const gateway = readFileSync('supabase/functions/ai-gateway/index.ts', 'utf8');
    assert.match(gateway, /liveSearch/);
    assert.match(gateway, /v1\/responses/);
    assert.match(gateway, /type: toolType/);
    assert.match(gateway, /tool_choice: 'required'/);
    assert.match(gateway, /LIVE_MAX_OUTPUT_TOKENS/);
    assert.doesNotMatch(gateway, /EXPO_PUBLIC_OPENAI/);
    const client = readFileSync('src/services/ai/ai-gateway-client.ts', 'utf8');
    assert.match(client, /liveSearch: request\.liveSearch === true/);
    const companion = readFileSync('src/services/voxa-companion-service.ts', 'utf8');
    assert.match(companion, /resolveLiveInformationPlan/);
    assert.match(companion, /livePlan\.kind !== 'none'/);
    assert.match(companion, /WEATHER_ASK_CITY_USER_LINE/);
  });
});

const TABLE_DUMP = [
  'Manchester City are currently top of the Premier League.',
  'Manchester City 5-0',
  'Arsenal FC 4-1',
  'Brighton & Hove Albion 3-1',
  'Brentford FC 2-0',
  'Leeds United 2-0',
  'Liverpool FC 2-0',
  'Chelsea 2-1',
  'Tottenham Hotspur 1-1',
].join('\n');

describe('live sports standings presentation', () => {
  it('keeps who-is-top answers to the leader, even when search text contains a table', () => {
    assert.equal(classifyLeagueTableAsk("Who's top of the Premier League?").kind, 'leader');
    const shaped = shapeLivePublicAnswer("Who's top of the Premier League?", TABLE_DUMP);
    assert.match(shaped, /Manchester City are currently top/i);
    assert.doesNotMatch(shaped, /Liverpool FC 2-0/);
    assert.doesNotMatch(shaped, /Brighton & Hove Albion/);
  });

  it('honours top N and named-team asks, and allows an explicit full table', () => {
    const top3 = shapeLivePublicAnswer('Who are the top 3?', TABLE_DUMP);
    assert.match(top3, /Manchester City 5-0/);
    assert.match(top3, /Arsenal FC 4-1/);
    assert.match(top3, /Brighton & Hove Albion 3-1/);
    assert.doesNotMatch(top3, /Liverpool FC 2-0/);

    const arsenal = shapeLivePublicAnswer('Where are Arsenal?', TABLE_DUMP);
    assert.match(arsenal, /Arsenal FC 4-1/);
    assert.doesNotMatch(arsenal, /Leeds United 2-0/);

    const full = shapeLivePublicAnswer('Show me the Premier League table.', TABLE_DUMP);
    assert.match(full, /Liverpool FC 2-0/);
  });

  it('does not trim boxing or news answers', () => {
    const boxing = 'Fury vs Usyk is the main event this weekend in Riyadh.';
    assert.equal(shapeLivePublicAnswer('What major boxing fights are happening this weekend?', boxing), boxing);
    const news = 'Several outlets reported a new product announcement this morning.';
    assert.equal(shapeLivePublicAnswer('What are the latest major news stories today?', news), news);
  });
});
