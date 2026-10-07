import { formatRelativeDateContext, resolveRelativeDateWindow } from './relative-calendar';

export type LiveInformationKind = 'none' | 'weather' | 'public';

export type LiveInformationPlan = {
  kind: LiveInformationKind;
  liveSearch: boolean;
  askForWeatherCity: boolean;
  weatherPlaceQuery?: string;
};

const NON_LIVE =
  /\b(remember my|favourite colour|favorite color|explain recursion|write me a study plan|help me plan my evening|help me plan my day)\b/i;

const WEATHER =
  /\b(weather|forecast|temperature|how hot|how cold|raining|umbrella|humidity|windy outside)\b/i;

const TIME_SENSITIVE =
  /\b(today|tonight|tomorrow|this weekend|next weekend|this week|next week|right now|currently|current|latest|live|breaking|this morning|this afternoon|this evening)\b/i;

const PUBLIC_EVENTS =
  /\b(premier league|pl|la liga|serie a?|bundesliga|champions league|score|standings?|table|fixture|fixtures|kick-?off|who's winning|who is winning|who won|winning the|first on the|games? (are |is )?on|boxing|fight card|fighting|ufc|mma|headline|in the news|news about|news stories|major news|latest news|what's happening with|what is happening with|what happened in|what happened today)\b/i;

const SPORTS_NEXT =
  /\b(who('s| is) .+ playing next|who do .+ play|next (game|fixture|match|fight)|when is .+ fighting)\b/i;

const DISTANCE =
  /\b(how far|distance (from|between)|drive from|walk from|travel time|how long (does it take )?to (drive|walk|get))\b/i;

const POSTCODE = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i;

const BIOGRAPHY_ONLY =
  /^(who('s| is) [a-z][a-z .'-]{1,40}\??)$/i;

const PLACE_STOP =
  /^(today|tonight|tomorrow|the|a|an|my|our|this|that|like|weather|forecast|now|please)$/i;

export function classifyLiveInformationNeed(userMessage: string): LiveInformationKind {
  const text = userMessage.trim();
  if (!text) return 'none';
  if (NON_LIVE.test(text)) return 'none';
  if (WEATHER.test(text)) return 'weather';
  if (DISTANCE.test(text) || (POSTCODE.test(text) && /\b(from|to|and|between|far)\b/i.test(text))) {
    return 'public';
  }
  if (SPORTS_NEXT.test(text) || PUBLIC_EVENTS.test(text)) return 'public';
  if (
    TIME_SENSITIVE.test(text) &&
    /\b(news|games?|match|fight|score|league|arsenal|weather|price|stock|happening|happened|headline|standings?|table|fixture)\b/i.test(
      text,
    )
  ) {
    return 'public';
  }
  if (BIOGRAPHY_ONLY.test(text) && !TIME_SENSITIVE.test(text) && !PUBLIC_EVENTS.test(text)) {
    return 'none';
  }
  return 'none';
}

export function liveSearchShouldRun(kind: LiveInformationKind): boolean {
  return kind === 'public';
}

function usablePlace(candidate: string | undefined): string | undefined {
  const place = candidate?.trim().replace(/[?!.]+$/g, '');
  if (!place || PLACE_STOP.test(place) || place.split(/\s+/).length > 4) return undefined;
  if (!/^[A-Za-z][A-Za-z .'-]{1,40}$/.test(place)) return undefined;
  return place;
}

export function extractWeatherPlace(userMessage: string): string | undefined {
  const text = userMessage.trim().replace(/[?!.]+$/g, '');
  if (!text) return undefined;
  const patterns = [
    /\b(?:today|tonight|tomorrow)\s+in\s+([A-Za-z][A-Za-z .'-]{1,40})$/i,
    /\bin\s+([A-Za-z][A-Za-z .'-]{1,40})\s+(?:today|tonight|tomorrow)\b/i,
    /\b(?:weather|forecast)(?:\s+\w+){0,8}?\s+(?:in|for|near|around)\s+([A-Za-z][A-Za-z .'-]{1,40})$/i,
    /\b(?:in|for|near|around)\s+([A-Za-z][A-Za-z .'-]{1,40})$/i,
  ];
  for (const pattern of patterns) {
    const place = usablePlace(text.match(pattern)?.[1]);
    if (place) return place;
  }
  return undefined;
}

export function isWeatherCityFollowUp(userMessage: string, previousAssistantText?: string): boolean {
  if (!previousAssistantText || !/what city are you in/i.test(previousAssistantText)) return false;
  const text = userMessage.trim().replace(/[?!.]+$/g, '');
  if (!text || WEATHER.test(text) || NON_LIVE.test(text)) return false;
  if (text.split(/\s+/).length > 5) return false;
  return Boolean(usablePlace(text));
}

export function resolveLiveInformationPlan(input: {
  userMessage: string;
  previousAssistantText?: string;
  hasSavedWeatherLocation?: boolean;
  weatherGrounded?: boolean;
}): LiveInformationPlan {
  const kind = classifyLiveInformationNeed(input.userMessage);
  const followUpCity = isWeatherCityFollowUp(input.userMessage, input.previousAssistantText)
    ? input.userMessage.trim().replace(/[?!.]+$/g, '')
    : undefined;
  const weatherPlaceQuery = extractWeatherPlace(input.userMessage) ?? followUpCity;
  const effectiveKind: LiveInformationKind =
    kind === 'none' && followUpCity ? 'weather' : kind;

  if (effectiveKind === 'weather') {
    if (weatherPlaceQuery) {
      return {
        kind: 'weather',
        liveSearch: input.weatherGrounded === false,
        askForWeatherCity: false,
        weatherPlaceQuery,
      };
    }
    if (input.hasSavedWeatherLocation) {
      return {
        kind: 'weather',
        liveSearch: input.weatherGrounded === false,
        askForWeatherCity: false,
      };
    }
    return { kind: 'weather', liveSearch: false, askForWeatherCity: true };
  }

  if (effectiveKind === 'public') {
    return { kind: 'public', liveSearch: true, askForWeatherCity: false };
  }

  return { kind: 'none', liveSearch: false, askForWeatherCity: false };
}

/** Public search query: the user's question only — never memories or notes. */
export function minimizedLiveSearchQuestion(userMessage: string): string {
  return userMessage.replace(/^\s*\[Photo[^\]]*\]\s*$/gim, '').trim().slice(0, 280);
}

export function liveInformationSystemBlock(input: {
  timeZone: string;
  nowIso: string;
  locationLabel?: string;
}): string {
  const location = input.locationLabel?.trim();
  const now = new Date(input.nowIso);
  const window = resolveRelativeDateWindow(Number.isNaN(now.getTime()) ? new Date() : now, input.timeZone);
  return [
    '## Current public information',
    formatRelativeDateContext(window),
    location ? `Named place in this question: ${location}.` : '',
    'The web search tool is enabled for this turn. You must use it before answering.',
    `Convert event and fixture times into ${input.timeZone} only. Do not also list PDT, PST, EST, ET, or other zones unless the user asks.`,
    'Answer from the search results. Distinguish live events, completed events, upcoming fixtures, and standings when relevant.',
    'Keep the answer conversational: direct answer first, then at most three short supporting bullets if they help. Do not dump every search hit.',
    'For league standings, name the leader and optionally second place unless the user asked for the full table. Do not paste the whole table.',
    'If the user asked who is top, do not list the rest of the league. If they asked for top N, list only N teams. If they asked where a named side is, answer that side only.',
    'Never show JSON, tool-call text, function names, or raw search payloads.',
    'For event lists, include only events inside the requested local date range. Group sources at the end — do not repeat a URL after every item.',
    'Do not use markdown links, raw URLs, or tracking parameters. Source names only.',
    'Prefer official or well-known outlets over thin aggregator pages when sources disagree.',
    'If the question is about weather, report conditions from retrieval. Never say you cannot access weather.',
    'If the question is distance or travel time: do not invent. If you cannot verify, say you could not verify the exact distance. Do not present straight-line distance as walking or driving time.',
    'If sources disagree, say so briefly. If search cannot verify the answer, say current information could not be verified and invite a retry.',
    'Do not guess scores, fixtures, weather, distances, or news from training memory.',
    'Do not put private memories, notes, or personal details into search queries.',
  ]
    .filter(Boolean)
    .join('\n');
}

const WORD_TOP_N: Record<string, number> = {
  three: 3,
  four: 4,
  five: 5,
  ten: 10,
};

export type LeagueTableAsk =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'leader' }
  | { kind: 'top'; n: number }
  | { kind: 'team'; team: string };

export function classifyLeagueTableAsk(userMessage: string): LeagueTableAsk {
  const text = userMessage.trim();
  if (!text) return { kind: 'none' };
  if (/\b(full table|whole table|entire table|league table|show (?:me )?the (?:premier league |pl )?table)\b/i.test(text)) {
    return { kind: 'full' };
  }
  const top = text.match(/\btop\s+(\d+|three|four|five|ten)\b/i);
  if (top) {
    const raw = top[1].toLowerCase();
    const n = WORD_TOP_N[raw] ?? Number(raw);
    if (n >= 1 && n <= 20) return { kind: 'top', n };
  }
  const team = text.match(/\bwhere (?:are|is)\s+([A-Za-z][A-Za-z .'-]{1,30}?)\s*\??$/i);
  if (team) return { kind: 'team', team: team[1].trim() };
  if (
    /\b(who(?:'s| is) (?:top|first|leading)|first on the|top of the (?:premier league|pl|table|league))\b/i.test(
      text,
    )
  ) {
    return { kind: 'leader' };
  }
  return { kind: 'none' };
}

function stripListPrefix(line: string): string {
  return line.replace(/^[-•*]\s+/, '').replace(/^\d+[\.)]\s+/, '').trim();
}

function isStandingsRow(line: string): boolean {
  const text = stripListPrefix(line);
  if (text.length < 5 || text.length > 64) return false;
  return (
    /^[A-Z][A-Za-z0-9 .&'-]{1,36}\s+\d+(?:\s*[-–]\s*\d+)(?:\s+\d+)?$/.test(text) ||
    /^[A-Z][A-Za-z0-9 .&'-]{1,36}\s+\d{1,3}\spts?\b/i.test(text)
  );
}

/** Drop copied league tables unless the user asked for that much of the table. */
export function shapeLivePublicAnswer(userMessage: string, answer: string): string {
  const ask = classifyLeagueTableAsk(userMessage);
  if (ask.kind === 'none' || ask.kind === 'full') return answer.trim();

  const lines = answer
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const table = lines.filter(isStandingsRow);
  if (table.length < 4 && ask.kind !== 'team') return answer.trim();

  const prose = lines.filter((line) => !isStandingsRow(line));
  let keptTable: string[] = [];
  if (ask.kind === 'leader') {
    keptTable = prose.length > 0 ? [] : table.slice(0, 2);
  } else if (ask.kind === 'top') {
    keptTable = table.slice(0, ask.n);
  } else {
    const needle = ask.team.toLowerCase();
    keptTable = table.filter((line) => stripListPrefix(line).toLowerCase().includes(needle)).slice(0, 1);
  }

  const shaped = [...prose.slice(0, 4), ...keptTable].join('\n').trim();
  return shaped || answer.trim();
}

export const WEATHER_NEED_LOCATION_LINE =
  'No weather location is saved. Ask which city they want the forecast for, or to set it in Settings → Weather location. Do not invent a city or a forecast.';

export const WEATHER_ASK_CITY_USER_LINE = 'Sure — what city are you in?';
