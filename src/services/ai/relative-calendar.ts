export type DateRangeLabel = {
  start: string;
  end: string;
};

export type RelativeDateWindow = {
  timeZone: string;
  weekday: string;
  today: string;
  tomorrow: string;
  tonight: string;
  thisWeekend: DateRangeLabel;
  nextWeekend: DateRangeLabel;
  thisWeek: DateRangeLabel;
  nextWeek: DateRangeLabel;
};

type ZoneParts = {
  weekday: string;
  weekdayIndex: number;
  year: number;
  month: number;
  day: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function zoneParts(date: Date, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = read('weekday');
  return {
    weekday,
    weekdayIndex: WEEKDAY_INDEX[weekday] ?? 0,
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
  };
}

function atLocalNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function addDays(parts: ZoneParts, days: number): Date {
  return atLocalNoon(parts.year, parts.month, parts.day + days);
}

function formatLongDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function weekendForSaturdayOffset(today: ZoneParts, timeZone: string, saturdayOffset: number): DateRangeLabel {
  const saturday = addDays(today, saturdayOffset);
  const sunday = addDays(today, saturdayOffset + 1);
  return {
    start: formatLongDate(saturday, timeZone),
    end: formatLongDate(sunday, timeZone),
  };
}

/**
 * Calendar windows in the user's timezone.
 * "This weekend" is Saturday–Sunday only (never Thursday/Friday).
 */
export function resolveRelativeDateWindow(now: Date, timeZone: string): RelativeDateWindow {
  const tz = timeZone.trim() || 'UTC';
  const today = zoneParts(now, tz);
  const daysUntilSaturday = (6 - today.weekdayIndex + 7) % 7;
  const thisSaturdayOffset = today.weekdayIndex === 0 ? -1 : daysUntilSaturday;
  const nextSaturdayOffset = thisSaturdayOffset + 7;
  const mondayOffset = today.weekdayIndex === 0 ? -6 : 1 - today.weekdayIndex;

  return {
    timeZone: tz,
    weekday: today.weekday,
    today: formatLongDate(atLocalNoon(today.year, today.month, today.day), tz),
    tomorrow: formatLongDate(addDays(today, 1), tz),
    tonight: formatLongDate(atLocalNoon(today.year, today.month, today.day), tz),
    thisWeekend: weekendForSaturdayOffset(today, tz, thisSaturdayOffset),
    nextWeekend: weekendForSaturdayOffset(today, tz, nextSaturdayOffset),
    thisWeek: {
      start: formatLongDate(addDays(today, mondayOffset), tz),
      end: formatLongDate(addDays(today, mondayOffset + 6), tz),
    },
    nextWeek: {
      start: formatLongDate(addDays(today, mondayOffset + 7), tz),
      end: formatLongDate(addDays(today, mondayOffset + 13), tz),
    },
  };
}

export function formatRelativeDateContext(window: RelativeDateWindow): string {
  return [
    `Local calendar (${window.timeZone}): today is ${window.today}. Tomorrow is ${window.tomorrow}. Tonight is still ${window.tonight}.`,
    `This weekend means ${window.thisWeekend.start} through ${window.thisWeekend.end} only — Saturday and Sunday. Do not include Thursday or Friday. Do not include ${window.tomorrow} unless the user asked about tomorrow.`,
    `Next weekend means ${window.nextWeekend.start} through ${window.nextWeekend.end}.`,
    `This week means ${window.thisWeek.start} through ${window.thisWeek.end}. Next week means ${window.nextWeek.start} through ${window.nextWeek.end}.`,
  ].join('\n');
}
