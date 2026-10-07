export type WeatherToolId =
  | 'current_weather'
  | 'hourly_forecast'
  | 'daily_forecast'
  | 'rain_probability'
  | 'clothing_suggestion'
  | 'running_suitability';

export type WeatherToolRequest = {
  tool: WeatherToolId;
  hours?: number;
  days?: number;
};

export type WeatherToolResult = {
  tool: WeatherToolId;
  available: boolean;
  summary: string;
  details: string[];
  grounded: boolean;
  dataTimestamp?: string;
  locationLabel?: string;
};

export const WEATHER_TOOL_CONTRACTS: Record<
  WeatherToolId,
  { description: string; requiresData: boolean }
> = {
  current_weather: {
    description: 'Current temperature, conditions, humidity, and wind at the saved location.',
    requiresData: true,
  },
  hourly_forecast: {
    description: 'Hour-by-hour forecast for the next several hours.',
    requiresData: true,
  },
  daily_forecast: {
    description: 'Daily highs, lows, and conditions for upcoming days.',
    requiresData: true,
  },
  rain_probability: {
    description: 'When rain is likely and how strong precipitation may be.',
    requiresData: true,
  },
  clothing_suggestion: {
    description: 'What to wear based on temperature, rain, and wind — grounded in forecast data.',
    requiresData: true,
  },
  running_suitability: {
    description: 'Whether conditions are good for outdoor exercise in the next few hours.',
    requiresData: true,
  },
};

export const WEATHER_UNAVAILABLE_AI_LINE =
  'No weather location is saved. Ask which city they want, or to set it in Settings → Weather location. Do not invent a city or a forecast.';
