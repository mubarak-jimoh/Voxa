import * as Location from 'expo-location';

import { IStorageService } from '../contracts';
import { WeatherFetchResult, WeatherLocationPreference } from '../../types/weather';
import {
  getWeatherCacheService,
  getWeatherLocationPreferenceService,
  WeatherLocationPreferenceService,
} from './weather-storage-service';
import {
  geocodeCity,
  OpenMeteoWeatherProvider,
  ProxyWeatherProvider,
} from './open-meteo-weather-provider';
import { MockWeatherProvider, WeatherProvider } from './weather-providers';

function resolveProvider(): WeatherProvider {
  const proxyUrl = process.env.EXPO_PUBLIC_WEATHER_API_URL?.trim();
  if (proxyUrl) return new ProxyWeatherProvider(proxyUrl);
  if (process.env.EXPO_PUBLIC_WEATHER_PROVIDER === 'mock') {
    return new MockWeatherProvider();
  }
  return new OpenMeteoWeatherProvider();
}

export class WeatherService {
  private readonly preferenceService: WeatherLocationPreferenceService;
  private readonly cacheService;
  private readonly provider: WeatherProvider;

  constructor(private readonly storage: IStorageService) {
    this.preferenceService = getWeatherLocationPreferenceService(storage);
    this.cacheService = getWeatherCacheService(storage);
    this.provider = resolveProvider();
  }

  async getPreference() {
    return this.preferenceService.get();
  }

  formatLocationLabel(pref: WeatherLocationPreference) {
    return this.preferenceService.formatLabel(pref);
  }

  async requestDeviceLocation(): Promise<
    | { ok: true; preference: WeatherLocationPreference }
    | { ok: false; reason: 'permission_denied' | 'services_disabled' | 'unavailable'; message: string }
  > {
    await this.preferenceService.markPermissionPromptShown();
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      await this.preferenceService.save({
        mode: 'not_set',
        locationServicesEnabled: false,
        permissionStatus: 'denied',
      });
      return {
        ok: false,
        reason: 'services_disabled',
        message: 'Location services are turned off on this device. Choose a city manually instead.',
      };
    }

    const current = await Location.getForegroundPermissionsAsync();
    let status = current.status;
    if (status !== Location.PermissionStatus.GRANTED) {
      const requested = await Location.requestForegroundPermissionsAsync();
      status = requested.status;
    }

    if (status !== Location.PermissionStatus.GRANTED) {
      await this.preferenceService.save({
        mode: 'not_set',
        permissionStatus: 'denied',
        locationServicesEnabled: true,
      });
      return {
        ok: false,
        reason: 'permission_denied',
        message: 'Location access is off. Choose a city manually and Voxa will use that for weather.',
      };
    }

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const places = await Location.reverseGeocodeAsync({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
    const place = places[0];
    const preference = await this.preferenceService.save({
      mode: 'device',
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      cityName: place?.city ?? place?.subregion ?? place?.region ?? 'Your area',
      region: place?.region ?? place?.subregion ?? undefined,
      country: place?.country ?? undefined,
      permissionStatus: 'granted',
      locationServicesEnabled: true,
    });
    await this.cacheService.write({
      bundle: await this.provider.fetchForecast({
        latitude: preference.latitude!,
        longitude: preference.longitude!,
        locationLabel: this.preferenceService.formatLabel(preference),
      }),
      cachedAt: new Date().toISOString(),
    });
    return { ok: true, preference };
  }

  async saveManualCity(query: string): Promise<
    | { ok: true; preference: WeatherLocationPreference }
    | { ok: false; message: string }
  > {
    const hit = await geocodeCity(query);
    if (!hit) {
      return { ok: false, message: 'Could not find that city. Try adding a country or region.' };
    }
    const preference = await this.preferenceService.save({
      mode: 'manual',
      cityName: hit.name,
      region: hit.admin1,
      country: hit.country,
      latitude: hit.latitude,
      longitude: hit.longitude,
      permissionStatus: 'denied',
      locationServicesEnabled: true,
    });
    await this.cacheService.write({
      bundle: await this.provider.fetchForecast({
        latitude: hit.latitude,
        longitude: hit.longitude,
        locationLabel: this.preferenceService.formatLabel(preference),
      }),
      cachedAt: new Date().toISOString(),
    });
    return { ok: true, preference };
  }

  async chooseNotNow(): Promise<WeatherLocationPreference> {
    return this.preferenceService.save({ mode: 'declined', permissionPromptShown: true });
  }

  async hasSavedLocation(): Promise<boolean> {
    const preference = await this.preferenceService.get();
    return this.preferenceService.hasResolvableLocation(preference);
  }

  async fetchForecastForPlace(query: string): Promise<WeatherFetchResult> {
    const hit = await geocodeCity(query);
    if (!hit) {
      return {
        ok: false,
        reason: 'no_location',
        message: 'Could not find that city.',
      };
    }
    try {
      const bundle = await this.provider.fetchForecast({
        latitude: hit.latitude,
        longitude: hit.longitude,
        locationLabel: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
      });
      return { ok: true, data: bundle };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Weather unavailable';
      return {
        ok: false,
        reason: message.toLowerCase().includes('network') ? 'offline' : 'provider_error',
        message,
      };
    }
  }

  async fetchForecast(options?: { force?: boolean }): Promise<WeatherFetchResult> {
    const preference = await this.preferenceService.get();
    if (preference.mode === 'declined') {
      return {
        ok: false,
        reason: 'no_location',
        message: 'Weather location is not set. Choose a city in Settings when you are ready.',
      };
    }
    if (!this.preferenceService.hasResolvableLocation(preference)) {
      if (preference.permissionStatus === 'denied') {
        return {
          ok: false,
          reason: 'permission_denied',
          message: 'Location access is off. Choose a city manually in Settings → Weather location.',
        };
      }
      return {
        ok: false,
        reason: 'no_location',
        message: 'Set your weather location in Settings to get forecasts.',
      };
    }

    const cached = await this.cacheService.read();
    if (!options?.force && cached && this.cacheService.isFresh(cached.cachedAt)) {
      return { ok: true, data: { ...cached.bundle, fromCache: true } };
    }

    try {
      const bundle = await this.provider.fetchForecast({
        latitude: preference.latitude!,
        longitude: preference.longitude!,
        locationLabel: this.preferenceService.formatLabel(preference),
      });
      await this.cacheService.write({ bundle, cachedAt: new Date().toISOString() });
      return { ok: true, data: bundle };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Weather unavailable';
      if (cached) {
        // Prefer serving real cached data rather than inventing weather.
        return {
          ok: true,
          data: { ...cached.bundle, fromCache: true },
        };
      }
      return {
        ok: false,
        reason: message.toLowerCase().includes('network') ? 'offline' : 'provider_error',
        message,
      };
    }
  }

  shouldShowFirstRunPrompt(pref: WeatherLocationPreference): boolean {
    return pref.mode === 'not_set' && !pref.permissionPromptShown;
  }
}

let weatherInstance: WeatherService | null = null;

export function getWeatherService(storage: IStorageService) {
  if (!weatherInstance) weatherInstance = new WeatherService(storage);
  return weatherInstance;
}

export function resetWeatherService() {
  weatherInstance = null;
}
