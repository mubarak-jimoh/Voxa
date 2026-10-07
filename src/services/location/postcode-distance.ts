import { geocodeCity } from '../weather/open-meteo-weather-provider';

export type DistanceLookup =
  | { ok: true; fromLabel: string; toLabel: string; kilometres: number }
  | { ok: false; reason: 'unverified' | 'parse' };

const UK_POSTCODE =
  /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/i;

const HOW_FAR = /\bhow far is\s+(.+?)\s+from\s+(.+?)\s*\??$/i;

export function normalizeUkPostcode(raw: string): string | undefined {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  const match = compact.match(/^([A-Z]{1,2}\d{1,2}[A-Z]?)(\d[A-Z]{2})$/);
  if (!match) return undefined;
  return `${match[1]} ${match[2]}`;
}

export function parseDistanceQuestion(userMessage: string): { from: string; to: string } | undefined {
  const text = userMessage.trim().replace(/[?!.]+$/g, '');
  const far = text.match(HOW_FAR);
  if (far?.[1] && far[2]) {
    return { from: far[1].trim(), to: far[2].trim() };
  }
  const codes = [...text.matchAll(new RegExp(UK_POSTCODE, 'gi'))].map((item) =>
    normalizeUkPostcode(`${item[1]}${item[2]}`),
  );
  const unique = [...new Set(codes.filter(Boolean))] as string[];
  if (unique.length >= 2) return { from: unique[0], to: unique[1] };
  return undefined;
}

export function haversineKilometres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const lat1 = toRad(from.latitude);
  const lat2 = toRad(to.latitude);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatStraightLineDistance(kilometres: number): string {
  if (kilometres < 1) {
    return `${Math.round(kilometres * 1000)} metres`;
  }
  const rounded = kilometres < 10 ? kilometres.toFixed(1) : String(Math.round(kilometres));
  return `${rounded} km`;
}

async function geocodePlace(query: string): Promise<{ label: string; latitude: number; longitude: number } | null> {
  const postcode = normalizeUkPostcode(query);
  if (postcode) {
    const compact = postcode.replace(/\s+/g, '');
    const response = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`);
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      status?: number;
      result?: { postcode?: string; latitude?: number; longitude?: number };
    };
    if (
      payload.status !== 200 ||
      typeof payload.result?.latitude !== 'number' ||
      typeof payload.result?.longitude !== 'number'
    ) {
      return null;
    }
    return {
      label: payload.result.postcode ?? postcode,
      latitude: payload.result.latitude,
      longitude: payload.result.longitude,
    };
  }
  const city = await geocodeCity(query);
  if (!city) return null;
  return {
    label: [city.name, city.admin1, city.country].filter(Boolean).join(', '),
    latitude: city.latitude,
    longitude: city.longitude,
  };
}

export async function lookupStraightLineDistance(userMessage: string): Promise<DistanceLookup> {
  const parsed = parseDistanceQuestion(userMessage);
  if (!parsed) return { ok: false, reason: 'parse' };
  try {
    const [from, to] = await Promise.all([geocodePlace(parsed.from), geocodePlace(parsed.to)]);
    if (!from || !to) return { ok: false, reason: 'unverified' };
    return {
      ok: true,
      fromLabel: from.label,
      toLabel: to.label,
      kilometres: haversineKilometres(from, to),
    };
  } catch {
    return { ok: false, reason: 'unverified' };
  }
}

export function formatVerifiedDistanceReply(result: Extract<DistanceLookup, { ok: true }>): string {
  const span = formatStraightLineDistance(result.kilometres);
  return `${result.fromLabel} and ${result.toLabel} are approximately ${span} apart in a straight line. I can't verify an exact walking or driving route from the available data.`;
}

export const DISTANCE_UNVERIFIED_LINE =
  "I couldn't verify the exact route distance right now.";
