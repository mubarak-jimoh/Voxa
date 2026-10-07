const UNIT_MS: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
};

const WORD_AMOUNTS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const RELATIVE_NUMERIC =
  /\bin\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|minute|hours?|hrs?|hour)\b/i;
const RELATIVE_WORD =
  /\bin\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(seconds?|secs?|minutes?|mins?|minute|hours?|hrs?|hour)\b/i;

export function resolveRelativeReminderDelayMs(text: string): number | null {
  const numeric = text.match(RELATIVE_NUMERIC);
  if (numeric) {
    const amount = Number(numeric[1]);
    const unit = numeric[2].toLowerCase();
    const ms = UNIT_MS[unit];
    if (amount > 0 && ms) {
      const delay = amount * ms;
      if (delay <= 24 * 60 * 60_000) return delay;
    }
  }
  const word = text.match(RELATIVE_WORD);
  if (word) {
    const amount = WORD_AMOUNTS[word[1].toLowerCase()];
    const unit = word[2].toLowerCase();
    const ms = UNIT_MS[unit];
    if (amount > 0 && ms) {
      const delay = amount * ms;
      if (delay <= 24 * 60 * 60_000) return delay;
    }
  }
  return null;
}
