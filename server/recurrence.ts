import { ruleFromString, type RepeatRule } from '../src/domain/repeatRule';
import { ApiFailure } from './db';
import {
  addDays, dayNumber, dayOfMonthOf, dayPart, daysInMonth, isDay, isLeapYear, monthOf, timePart, weekdayOf, yearOf,
  laterDay,
} from './dates';

/**
 * Where a task falls, and where a recurring one goes next.
 *
 * Repeat rules are the strings the app writes ("every monday", "every 3
 * days", "every! month", "every 2 weeks at 9:00"): `ruleFromString` reads
 * them, and this file counts the days. The count is done one day at a time
 * over a bounded range, so the answer is exact rather than a formula that
 * can drift at the end of a month or a leap year.
 *
 * Completing a recurring task moves it to the first occurrence after the later
 * of its due day and today: a task that is overdue jumps to the next time it
 * falls, not to a late day. A rule with "!" (`every!`) counts from the day it
 * was completed instead.
 */

/** How far ahead a rule is searched. Yearly rules on a leap day need about eight years. */
const SEARCH_DAYS = 366 * 12;

export interface DueInput {
  date?: unknown;
  string?: unknown;
  lang?: unknown;
  is_recurring?: unknown;
  timezone?: unknown;
}

/** A due as the database keeps it. `date` is `YYYY-MM-DD`, or with `THH:mm:ss`. */
export interface StoredDue {
  date: string;
  string: string | null;
  lang: string | null;
  timezone: string | null;
  recurring: boolean;
}

export function parseRule(raw: string): RepeatRule {
  const rule = ruleFromString(raw);
  if (!rule) throw ApiFailure.badRequest(`“${raw}” is not a repeat rule the server can read.`, 'INVALID_DATE');
  return rule;
}

/** Whether no later day of the month shares this day's weekday: the last Monday, the last Friday, and so on. */
const isLastOfMonth = (day: string): boolean => dayOfMonthOf(day) + 7 > daysInMonth(yearOf(day), monthOf(day));

/** A monthly weekday rule as its words give it: "last Monday" is `last`, "4th Tuesday" is 4. */
export interface NthWeekday {
  weekday: number;
  nth: number | 'last';
}

const folded = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const wordsOf = (text: string): string[] => folded(text).split(/[^a-z0-9]+/).filter(Boolean);

const DAY_WORDS: Record<string, number> = {
  sunday: 0, sun: 0, dimanche: 0, dim: 0, monday: 1, mon: 1, lundi: 1, lun: 1, tuesday: 2, tue: 2, mardi: 2, mar: 2,
  wednesday: 3, wed: 3, mercredi: 3, mer: 3, thursday: 4, thu: 4, thur: 4, jeudi: 4, jeu: 4, friday: 5, fri: 5,
  vendredi: 5, ven: 5, saturday: 6, sat: 6, samedi: 6, sam: 6,
};
const ORDINAL_WORDS: Record<string, number | 'last'> = {
  first: 1, second: 2, third: 3, fourth: 4, last: 'last', '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 'last',
  premier: 1, premiere: 1, '1er': 1, deuxieme: 2, '2e': 2, troisieme: 3, '3e': 3, quatrieme: 4, '4e': 4,
  dernier: 'last', derniere: 'last',
};

/** The weekday and the week a monthly rule names in its words, or null when it names neither. */
export function nthWeekdayOf(text: string): NthWeekday | null {
  const words = wordsOf(text);
  for (let at = 0; at + 1 < words.length; at += 1) {
    const nth = ORDINAL_WORDS[words[at]];
    const weekday = DAY_WORDS[words[at + 1].replace(/s$/, '')];
    if (nth !== undefined && weekday !== undefined) return { weekday, nth };
  }
  return null;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FR_MONTH_NAMES: Array<[string, number]> = [
  ['janv', 1], ['fev', 2], ['mars', 3], ['avr', 4], ['mai', 5], ['juin', 6], ['juil', 7], ['aout', 8], ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
];

/** The month a word names, in English or French and in full or short: "january", "janv", "juil". */
function monthNumber(word: string): number | null {
  const english = MONTH_NAMES.findIndex((name) => word.startsWith(name));
  if (english >= 0) return english + 1;
  return FR_MONTH_NAMES.find(([name]) => word.startsWith(name))?.[1] ?? null;
}

/**
 * The first day a yearly rule that names its date falls on, counted from today: "every 14 jan" and "chaque 14 janv."
 * Without it the rule would count from today's own month and day.
 */
function yearlyAnchor(text: string, today: string): string | null {
  const words = wordsOf(text);
  let month: number | null = null;
  let dayOfMonth = 0;
  words.forEach((word, at) => {
    const named = monthNumber(word);
    if (month !== null || named === null) return;
    const beside = [words[at - 1], words[at + 1]].map((near) => /^(\d{1,2})(?:er|st|nd|rd|th|e)?$/.exec(near ?? '')?.[1]);
    const day = beside.find((value) => value !== undefined);
    if (day !== undefined) { month = named; dayOfMonth = Number(day); }
  });
  if (month === null || !dayOfMonth) return null;
  const year = Number(today.slice(0, 4));
  for (let y = year; y <= year + 8; y += 1) {
    const candidate = `${y}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
    if (candidate >= today && isDay(candidate)) return candidate;
  }
  return null;
}

const isWorkday = (weekday: number): boolean => weekday !== 0 && weekday !== 6;

/** The workdays from `from` up to, not including, `to`. Each block of seven days holds five. */
function workdaysBetween(from: string, to: string): number {
  const span = dayNumber(to) - dayNumber(from);
  const start = weekdayOf(from);
  let count = Math.floor(span / 7) * 5;
  for (let step = 0; step < span % 7; step += 1) if (isWorkday((start + step) % 7)) count += 1;
  return count;
}

/** Whether a day is one a rule falls on, counting from `anchor`. */
export function occursOn(rule: RepeatRule, anchor: string, day: string, named: NthWeekday | null = null): boolean {
  if (day < anchor) return false;
  const interval = Math.max(1, rule.interval || 1);
  const span = dayNumber(day) - dayNumber(anchor);
  switch (rule.unit) {
    case 'day':
      return span % interval === 0;
    case 'workday': {
      const weekday = weekdayOf(day);
      if (weekday === 0 || weekday === 6) return false;
      return workdaysBetween(anchor, day) % interval === 0;
    }
    case 'week': {
      const weekdays = rule.weekdays.length ? rule.weekdays : [weekdayOf(anchor)];
      if (!weekdays.includes(weekdayOf(day))) return false;
      /* Weeks run Monday to Sunday; the interval counts whole weeks from the anchor's. */
      const mondayOf = (d: string) => dayNumber(d) - ((weekdayOf(d) + 6) % 7);
      return ((mondayOf(day) - mondayOf(anchor)) / 7) % interval === 0;
    }
    case 'month': {
      const months = (yearOf(day) - yearOf(anchor)) * 12 + (monthOf(day) - monthOf(anchor));
      if (months % interval !== 0) return false;
      if (rule.monthly === 'lastDay') return dayOfMonthOf(day) === daysInMonth(yearOf(day), monthOf(day));
      if (rule.monthly === 'weekday') {
        if (named) {
          return weekdayOf(day) === named.weekday && (named.nth === 'last' ? isLastOfMonth(day) : Math.ceil(dayOfMonthOf(day) / 7) === named.nth);
        }
        if (weekdayOf(day) !== weekdayOf(anchor)) return false;
        // Without the words, the start says it: its fifth week is the last, any other is the same week of the month.
        if (dayOfMonthOf(anchor) > 28) return isLastOfMonth(day);
        return Math.ceil(dayOfMonthOf(day) / 7) === Math.ceil(dayOfMonthOf(anchor) / 7);
      }
      /* The 31st does not exist in every month: such a month has no occurrence. */
      return dayOfMonthOf(day) === dayOfMonthOf(anchor);
    }
    case 'year': {
      const years = yearOf(day) - yearOf(anchor);
      if (years % interval !== 0) return false;
      if (monthOf(day) !== monthOf(anchor) || dayOfMonthOf(day) !== dayOfMonthOf(anchor)) return false;
      /* 29 February falls only in leap years. */
      return !(monthOf(anchor) === 2 && dayOfMonthOf(anchor) === 29) || isLeapYear(yearOf(day));
    }
    default:
      return false;
  }
}

/** The first day on or after `from` that the rule falls on, or null if none in range. */
export function nextOccurrence(rule: RepeatRule, anchor: string, from: string, named: NthWeekday | null = null): string | null {
  let day = dayPart(from);
  for (let step = 0; step < SEARCH_DAYS; step += 1) {
    if (rule.end && day > rule.end) return null;
    if (occursOn(rule, anchor, day, named)) return day;
    day = addDays(day, 1);
  }
  return null;
}

const withTime = (day: string, time: string | null): string => (time ? `${day}T${time}:00` : day);

/** The first day on or after `from` that is the given day of the month and that the rule falls on. */
function nextOnOrdinal(rule: RepeatRule, dayOfMonth: number, from: string): string | null {
  let day = dayPart(from);
  for (let step = 0; step < SEARCH_DAYS; step += 1) {
    if (rule.end && day > rule.end) return null;
    if (dayOfMonthOf(day) === dayOfMonth && occursOn(rule, day, day)) return day;
    day = addDays(day, 1);
  }
  return null;
}

/**
 * The due a recurring task moves to when it is completed, or null when the
 * rule has run out (the task is then simply done).
 */
export function advanceRecurring(due: StoredDue, today: string): StoredDue | null {
  const rule = parseRule(due.string ?? '');
  const dueDay = dayPart(due.date);
  // Completion counts from the day it happened; a plain rule from the later of the due day and today.
  const anchor = rule.fromCompletion ? today : dueDay;
  const base = rule.fromCompletion ? today : laterDay(dueDay, today);
  const named = rule.unit === 'month' && rule.monthly === 'day' ? /\b(\d{1,2})(?:st|nd|rd|th|er|e)\b/i.exec(due.string ?? '')?.[1] : undefined;
  const next = named
    ? nextOnOrdinal(rule, Number(named), addDays(base, 1))
    : nextOccurrence(rule, anchor, addDays(base, 1), nthWeekdayOf(due.string ?? ''));
  if (!next) return null;
  return { ...due, date: withTime(next, rule.time ?? timePart(due.date)) };
}

/** A due date is a day, and one with a time must have a real time after it. */
function checkDueDate(value: string): void {
  const shape = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  if (!shape.test(value) || !isDay(dayPart(value))) throw ApiFailure.badRequest(`“${value}” is not a date.`, 'INVALID_DATE');
}

/**
 * Turns a due sent by a client into the stored form, checking it on the way.
 *
 * A recurring due without a day gets the rule's first day, counted from today
 * in the user's timezone. Anything that is not a day is refused.
 */
export function resolveDue(input: DueInput | null | undefined, today: string): StoredDue | null {
  if (!input) return null;
  const recurring = input.is_recurring === true;
  const timezone = typeof input.timezone === 'string' && input.timezone ? input.timezone : null;
  const lang = typeof input.lang === 'string' && input.lang ? input.lang : null;
  const date = typeof input.date === 'string' ? input.date.trim() : '';

  if (recurring) {
    const string = typeof input.string === 'string' ? input.string.trim() : '';
    if (!string) throw ApiFailure.badRequest('A repeating task needs its repeat rule.', 'INVALID_DATE');
    const rule = parseRule(string);
    let day: string;
    if (date) {
      checkDueDate(date);
      day = dayPart(date);
    } else {
      // The start is written "starting …" in English and "à partir du …" in French, as the picker writes it.
      const starting = /(?:starting|from|partir (?:du|de)) (\d{4}-\d{2}-\d{2})/i.exec(string)?.[1];
      if (starting !== undefined && !isDay(starting)) throw ApiFailure.badRequest(`“${starting}” is not a date.`, 'INVALID_DATE');
      // "every 15th" names its day of the month, which the rule itself does not keep: the first date is the next 15th.
      const ordinal = rule.unit === 'month' && rule.monthly === 'day' ? /\b(\d{1,2})(?:st|nd|rd|th|er|e)\b/i.exec(string)?.[1] : undefined;
      const named = rule.unit === 'year' && !starting ? yearlyAnchor(string, today) : null;
      const first = ordinal
        ? nextOnOrdinal(rule, Number(ordinal), starting ?? today)
        : nextOccurrence(rule, starting ?? named ?? today, starting ?? today, nthWeekdayOf(string));
      if (!first) throw ApiFailure.badRequest('That repeat rule never falls on a day.', 'INVALID_DATE');
      day = first;
    }
    return { date: withTime(day, rule.time ?? (date ? timePart(date) : null)), string, lang, timezone, recurring: true };
  }

  if (!date) throw ApiFailure.badRequest('A task needs a date to be scheduled on.', 'INVALID_DATE');
  checkDueDate(date);
  const string = typeof input.string === 'string' && input.string.trim() ? input.string.trim() : dayPart(date);
  return { date, string, lang, timezone, recurring: false };
}

