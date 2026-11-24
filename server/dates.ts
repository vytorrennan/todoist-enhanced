/**
 * Calendar days, as the database and the app write them: `YYYY-MM-DD`, with an
 * optional `THH:mm:ss` when a task has a time. All arithmetic is done on whole
 * days in UTC, so a daylight-saving change cannot move a day.
 */

const DAY_MS = 86_400_000;

/** A real calendar day: the shape is right and the day exists (no 31 February). */
export const isDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};

/** The `YYYY-MM-DD` part of a due or deadline value. */
export const dayPart = (value: string): string => value.slice(0, 10);

/** The `HH:mm` of a value that carries a time, else null. */
export const timePart = (value: string): string | null => (value.length > 10 && value[10] === 'T' ? value.slice(11, 16) : null);

/** Whole days since 1970-01-01 for a `YYYY-MM-DD` day. */
export const dayNumber = (day: string): number => Math.round(Date.parse(`${dayPart(day)}T00:00:00Z`) / DAY_MS);

export const dayFromNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

export const addDays = (day: string, n: number): string => dayFromNumber(dayNumber(day) + n);

/** 0 = Sunday, like `Date.getDay()`. */
export const weekdayOf = (day: string): number => new Date(`${dayPart(day)}T00:00:00Z`).getUTCDay();

export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

export const yearOf = (day: string): number => Number(dayPart(day).slice(0, 4));
export const monthOf = (day: string): number => Number(dayPart(day).slice(5, 7));
export const dayOfMonthOf = (day: string): number => Number(dayPart(day).slice(8, 10));

export const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Today's date in a timezone, as `YYYY-MM-DD`. An unknown zone falls back to UTC. */
export function todayIn(timezone: string | null | undefined, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The later of two days. Both are `YYYY-MM-DD`, so string order is day order. */
export const laterDay = (a: string, b: string): string => (dayPart(a) >= dayPart(b) ? dayPart(a) : dayPart(b));
