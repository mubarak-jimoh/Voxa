import {
  WEATHER_TOOL_CONTRACTS,
  WEATHER_UNAVAILABLE_AI_LINE,
  WeatherToolId,
  WeatherToolRequest,
  WeatherToolResult,
} from '../../types/weather-ai-tools';
import { WeatherBundle } from '../../types/weather';
import { WeatherService } from './weather-service';

function formatHour(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function buildCurrentTool(bundle: WeatherBundle): WeatherToolResult {
  const c = bundle.current;
  return {
    tool: 'current_weather',
    available: true,
    grounded: true,
    dataTimestamp: bundle.fetchedAt,
    locationLabel: bundle.locationLabel,
    summary: `${bundle.locationLabel}: ${Math.round(c.temperatureC)}°C and ${c.conditionLabel.toLowerCase()}.`,
    details: [
      `Feels like ${Math.round(c.apparentTemperatureC)}°C`,
      `Humidity ${Math.round(c.humidityPercent)}%`,
      `Wind ${Math.round(c.windSpeedKmh)} km/h`,
      c.precipitationMm > 0 ? `Precipitation ${c.precipitationMm} mm` : 'No precipitation right now',
    ],
  };
}

function buildHourlyTool(bundle: WeatherBundle, hours = 6): WeatherToolResult {
  const slice = bundle.hourly.slice(0, hours);
  return {
    tool: 'hourly_forecast',
    available: true,
    grounded: true,
    dataTimestamp: bundle.fetchedAt,
    locationLabel: bundle.locationLabel,
    summary: `Next ${slice.length} hours in ${bundle.locationLabel}.`,
    details: slice.map(
      (point) =>
        `${formatHour(point.time)} · ${Math.round(point.temperatureC)}°C · ${point.conditionLabel} · ${point.precipitationProbabilityPercent}% rain`,
    ),
  };
}

function buildDailyTool(bundle: WeatherBundle, days = 5): WeatherToolResult {
  const slice = bundle.daily.slice(0, days);
  return {
    tool: 'daily_forecast',
    available: true,
    grounded: true,
    dataTimestamp: bundle.fetchedAt,
    locationLabel: bundle.locationLabel,
    summary: `${days}-day outlook for ${bundle.locationLabel}.`,
    details: slice.map(
      (day) =>
        `${day.date}: ${Math.round(day.tempMinC)}–${Math.round(day.tempMaxC)}°C · ${day.conditionLabel} · ${day.precipitationProbabilityMaxPercent}% rain`,
    ),
  };
}

function buildRainTool(bundle: WeatherBundle): WeatherToolResult {
  const rainy = bundle.hourly
    .slice(0, 12)
    .filter((point) => point.precipitationProbabilityPercent >= 40)
    .slice(0, 3);
  if (!rainy.length) {
    return {
      tool: 'rain_probability',
      available: true,
      grounded: true,
      dataTimestamp: bundle.fetchedAt,
      locationLabel: bundle.locationLabel,
      summary: `No significant rain expected in the next 12 hours in ${bundle.locationLabel}.`,
      details: [],
    };
  }
  return {
    tool: 'rain_probability',
    available: true,
    grounded: true,
    dataTimestamp: bundle.fetchedAt,
    locationLabel: bundle.locationLabel,
    summary: `Rain is possible in ${bundle.locationLabel} later today.`,
    details: rainy.map(
      (point) =>
        `${formatHour(point.time)} · ${point.precipitationProbabilityPercent}% chance of rain · ${point.conditionLabel}`,
    ),
  };
}

function buildClothingTool(bundle: WeatherBundle): WeatherToolResult {
  const temp = bundle.current.temperatureC;
  const rainSoon = bundle.hourly.slice(0, 4).some((point) => point.precipitationProbabilityPercent >= 50);
  const windy = bundle.current.windSpeedKmh >= 25;
  const layers: string[] = [];
  if (temp <= 8) layers.push('Warm layers and a coat');
  else if (temp <= 14) layers.push('Light jacket or jumper');
  else if (temp <= 22) layers.push('Light layers');
  else layers.push('Breathable, lighter clothing');
  if (rainSoon) layers.push('Take a waterproof jacket or umbrella');
  if (windy) layers.push('A wind-resistant outer layer would help');
  return {
    tool: 'clothing_suggestion',
    available: true,
    grounded: true,
    dataTimestamp: bundle.fetchedAt,
    locationLabel: bundle.locationLabel,
    summary: rainSoon
      ? `Rain is likely soon around ${bundle.locationLabel}, so take a light waterproof jacket.`
      : `It is ${Math.round(temp)}°C in ${bundle.locationLabel} — ${layers[0].toLowerCase()} should work well.`,
    details: layers,
  };
}

function buildRunningTool(bundle: WeatherBundle): WeatherToolResult {
  const window = bundle.hourly.slice(0, 3);
  const good = window.every(
    (point) =>
      point.precipitationProbabilityPercent < 35 &&
      !['rain', 'snow', 'thunderstorm'].includes(point.condition),
  );
  const temp = window[0]?.temperatureC ?? bundle.current.temperatureC;
  return {
    tool: 'running_suitability',
    available: true,
    grounded: true,
    dataTimestamp: bundle.fetchedAt,
    locationLabel: bundle.locationLabel,
    summary: good
      ? `It is dry and around ${Math.round(temp)}°C for the next couple of hours in ${bundle.locationLabel}, which makes this a good time for a run.`
      : `Conditions in ${bundle.locationLabel} may be less ideal for a run in the next few hours due to rain or strong weather.`,
    details: window.map(
      (point) =>
        `${formatHour(point.time)} · ${Math.round(point.temperatureC)}°C · ${point.precipitationProbabilityPercent}% rain · ${point.conditionLabel}`,
    ),
  };
}

export function unavailableWeatherTool(tool: WeatherToolId, message?: string): WeatherToolResult {
  return {
    tool,
    available: false,
    grounded: false,
    summary: message ?? WEATHER_UNAVAILABLE_AI_LINE,
    details: [WEATHER_UNAVAILABLE_AI_LINE],
  };
}

export async function executeWeatherTool(
  weatherService: WeatherService,
  request: WeatherToolRequest,
): Promise<WeatherToolResult> {
  const fetch = await weatherService.fetchForecast();
  if (!fetch.ok) {
    if (fetch.cached) {
      return executeWeatherToolOnBundle(fetch.cached, request);
    }
    return unavailableWeatherTool(request.tool, fetch.message);
  }
  return executeWeatherToolOnBundle(fetch.data, request);
}

export function executeWeatherToolOnBundle(bundle: WeatherBundle, request: WeatherToolRequest): WeatherToolResult {
  switch (request.tool) {
    case 'current_weather':
      return buildCurrentTool(bundle);
    case 'hourly_forecast':
      return buildHourlyTool(bundle, request.hours ?? 6);
    case 'daily_forecast':
      return buildDailyTool(bundle, request.days ?? 5);
    case 'rain_probability':
      return buildRainTool(bundle);
    case 'clothing_suggestion':
      return buildClothingTool(bundle);
    case 'running_suitability':
      return buildRunningTool(bundle);
    default:
      return unavailableWeatherTool(request.tool);
  }
}

const WEATHER_INTENT_PATTERNS: Array<{ tool: WeatherToolId; pattern: RegExp }> = [
  { tool: 'clothing_suggestion', pattern: /what should i wear|wear today|outfit|jacket|umbrella/i },
  { tool: 'running_suitability', pattern: /good (day|time) for a run|go for a run|run today|jog/i },
  { tool: 'rain_probability', pattern: /rain|umbrella|wet|shower|storm/i },
  { tool: 'hourly_forecast', pattern: /next (few )?hours|this afternoon|later today|hourly/i },
  { tool: 'daily_forecast', pattern: /this week|tomorrow|weekend|daily forecast|next few days/i },
  { tool: 'current_weather', pattern: /weather|temperature|how hot|how cold|forecast/i },
];

export function inferWeatherTool(message: string): WeatherToolRequest | null {
  for (const item of WEATHER_INTENT_PATTERNS) {
    if (item.pattern.test(message)) return { tool: item.tool };
  }
  return null;
}

export function formatWeatherToolsForPrompt(results: WeatherToolResult[]): string {
  if (!results.length) return '';
  const lines = results.flatMap((result) => {
    const contract = WEATHER_TOOL_CONTRACTS[result.tool];
    if (!result.available) {
      return [`- ${contract.description}: ${result.summary}`];
    }
    return [
      `- ${contract.description}`,
      `  Summary: ${result.summary}`,
      ...result.details.map((detail) => `  · ${detail}`),
      '  Rule: Answer ONLY using this data. Never invent weather.',
    ];
  });
  return [
    '## Grounded weather data',
    'You already have current measurements. Answer with these numbers.',
    'Never say you cannot access, check, or get real-time weather.',
    ...lines,
  ].join('\n');
}

export async function buildWeatherPromptBlock(
  weatherService: WeatherService,
  userMessage: string,
  options?: { placeQuery?: string },
): Promise<string> {
  const inferred = inferWeatherTool(userMessage) ?? (options?.placeQuery
    ? { tool: 'current_weather' as const }
    : null);
  if (!inferred) return '';
  if (options?.placeQuery) {
    const fetch = await weatherService.fetchForecastForPlace(options.placeQuery);
    if (!fetch.ok) {
      return formatWeatherToolsForPrompt([unavailableWeatherTool(inferred.tool, fetch.message)]);
    }
    return formatWeatherToolsForPrompt([executeWeatherToolOnBundle(fetch.data, inferred)]);
  }
  const result = await executeWeatherTool(weatherService, inferred);
  return formatWeatherToolsForPrompt([result]);
}

export function weatherPromptIsGrounded(block: string): boolean {
  return block.includes('Answer ONLY using this data');
}
