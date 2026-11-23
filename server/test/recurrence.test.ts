import { describe, expect, it } from 'vitest';
import { advanceRecurring, nextOccurrence, occursOn, parseRule, resolveDue } from '../recurrence';
import { addDays, dayNumber, weekdayOf, laterDay, todayIn, timePart, isDay } from '../dates';
import { timezoneOffsetMinutes } from '../serialize';
import { ApiFailure } from '../db';

const due = (date: string, string: string) => ({ date, string, lang: 'en', timezone: null, recurring: true });

describe('days', () => {
  it('adds whole days across a month end, a leap day and a year end', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('knows the weekday, with Sunday as zero', () => {
    expect(weekdayOf('2026-11-22')).toBe(0);
    expect(weekdayOf('2026-11-23')).toBe(1);
  });

  it('recognises real days only', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2024-02-29')).toBe(true);
    expect(isDay('2026-13-01')).toBe(false);
    expect(isDay('26-01-01')).toBe(false);
  });

  it('reads the time of a due and the later of two days', () => {
    expect(timePart('2026-05-01T09:30:00')).toBe('09:30');
    expect(timePart('2026-05-01')).toBeNull();
    expect(laterDay('2026-05-01', '2026-05-03')).toBe('2026-05-03');
    expect(dayNumber('1970-01-02')).toBe(1);
  });

  it('gives today in the zone the person lives in, not the server’s', () => {
    const instant = new Date('2026-06-01T23:30:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-06-01');
    expect(todayIn('Pacific/Auckland', instant)).toBe('2026-06-02');
    expect(todayIn('Not/AZone', instant)).toBe('2026-06-01');
  });

  it('measures how far a zone is from UTC, both ways', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    expect(timezoneOffsetMinutes('Europe/Paris', winter)).toBe(60);
    expect(timezoneOffsetMinutes('America/New_York', winter)).toBe(-300);
    expect(timezoneOffsetMinutes('UTC', winter)).toBe(0);
  });
});

describe('repeat rules', () => {
  it('a daily rule falls every day, and an every-N-days rule every N days from its start', () => {
    expect(occursOn(parseRule('every day'), '2026-03-01', '2026-03-09')).toBe(true);
    const threes = parseRule('every 3 days');
    expect(occursOn(threes, '2026-03-01', '2026-03-04')).toBe(true);
    expect(occursOn(threes, '2026-03-01', '2026-03-05')).toBe(false);
    expect(occursOn(threes, '2026-03-01', '2026-02-28')).toBe(false);
  });

  it('a weekday rule falls on those weekdays only, and a bare week on the start’s own day', () => {
    const monday = parseRule('every monday');
    expect(occursOn(monday, '2026-11-23', '2026-11-30')).toBe(true);
    expect(occursOn(monday, '2026-11-23', '2026-11-24')).toBe(false);
    const bare = parseRule('every week');
    expect(occursOn(bare, '2026-11-23', '2026-11-30')).toBe(true);
    expect(occursOn(bare, '2026-11-23', '2026-11-24')).toBe(false);
  });

  it('a workday rule skips the weekend', () => {
    const workdays = parseRule('every weekday');
    expect(occursOn(workdays, '2026-11-20', '2026-11-21')).toBe(false);
    expect(occursOn(workdays, '2026-11-20', '2026-11-23')).toBe(true);
  });

  it('a fortnightly rule skips a week', () => {
    const fortnight = parseRule('every 2 weeks');
    expect(occursOn(fortnight, '2026-11-02', '2026-11-16')).toBe(true);
    expect(occursOn(fortnight, '2026-11-02', '2026-11-09')).toBe(false);
  });

  it('a monthly rule keeps its day, skips months that lack it, and a yearly one keeps its date', () => {
    const monthly = parseRule('every month');
    expect(occursOn(monthly, '2026-01-15', '2026-02-15')).toBe(true);
    expect(occursOn(monthly, '2026-01-31', '2026-02-28')).toBe(false);
    expect(nextOccurrence(monthly, '2026-01-31', '2026-02-01')).toBe('2026-03-31');
    const yearly = parseRule('every year');
    expect(occursOn(yearly, '2026-06-10', '2027-06-10')).toBe(true);
    expect(nextOccurrence(parseRule('every year'), '2024-02-29', '2025-01-01')).toBe('2028-02-29');
  });

  it('a rule with an end stops there', () => {
    const ending = parseRule('every day until 2026-01-03');
    expect(nextOccurrence(ending, '2026-01-01', '2026-01-03')).toBe('2026-01-03');
    expect(nextOccurrence(ending, '2026-01-01', '2026-01-04')).toBeNull();
  });

  it('the French day of the month is read the same way: "tous les 15e"', () => {
    const next = resolveDue({ string: 'tous les 15e', lang: 'fr', is_recurring: true }, '2026-11-23');
    expect(next?.date).toBe('2026-12-15');
  });

  it('a monthly rule that names its day keeps it: "every 15th" starts on the next 15th, not on today', () => {
    const next = resolveDue({ string: 'every 15th', lang: 'en', is_recurring: true }, '2026-11-23');
    expect(next?.date).toBe('2026-12-15');
    const onThe = resolveDue({ string: 'every 15th', lang: 'en', is_recurring: true }, '2026-11-15');
    expect(onThe?.date).toBe('2026-11-15');
  });

  it('a monthly day rule counts from its written start, in French as in English', () => {
    expect(resolveDue({ string: 'tous les 15e à partir du 2027-01-20', lang: 'fr', is_recurring: true }, '2026-11-23')?.date).toBe('2027-02-15');
    expect(resolveDue({ string: 'every 15th starting 2027-01-20', lang: 'en', is_recurring: true }, '2026-11-23')?.date).toBe('2027-02-15');
  });

  it('"every last Monday" moves to the last Monday of the next month, in whichever week that is', () => {
    const next = advanceRecurring({ date: '2026-11-30', string: 'every last monday', lang: 'en', timezone: null, recurring: true }, '2026-11-30');
    expect(next?.date.slice(0, 10)).toBe('2026-12-28');
  });

  it('a yearly rule that names its date starts on that date, not on today: "every 14 jan"', () => {
    expect(resolveDue({ string: 'every 14 jan', lang: 'en', is_recurring: true }, '2026-11-23')?.date).toBe('2027-01-14');
    expect(resolveDue({ string: 'every 14 jan', lang: 'en', is_recurring: true }, '2026-01-10')?.date).toBe('2026-01-14');
  });

  it('a fourth Monday that is also the last Monday of its month stays a fourth Monday', () => {
    expect(advanceRecurring({ date: '2026-02-23', string: 'every 4th monday', lang: 'en', timezone: null, recurring: true }, '2026-02-23')?.date.slice(0, 10)).toBe('2026-03-23');
    expect(advanceRecurring({ date: '2026-02-23', string: 'tous les 4e lundi', lang: 'fr', timezone: null, recurring: true }, '2026-02-23')?.date.slice(0, 10)).toBe('2026-03-23');
  });

  it('a last-Monday rule given without a date starts on that Monday, not on today\'s weekday', () => {
    expect(resolveDue({ string: 'every last monday', lang: 'en', is_recurring: true }, '2026-11-24')?.date.slice(0, 10)).toBe('2026-11-30');
    expect(resolveDue({ string: 'chaque dernier lundi', lang: 'fr', is_recurring: true }, '2026-11-24')?.date.slice(0, 10)).toBe('2026-11-30');
  });

  it('a yearly date written in full or with a time still names its day: "every 14 January", "every jan 14 at 9:00"', () => {
    expect(resolveDue({ string: 'every 14 January', lang: 'en', is_recurring: true }, '2026-11-23')?.date.slice(0, 10)).toBe('2027-01-14');
    expect(resolveDue({ string: 'every jan 14 at 9:00', lang: 'en', is_recurring: true }, '2026-11-23')?.date.slice(0, 10)).toBe('2027-01-14');
  });

  it('"every 29 jan" falls every year, not only in leap years', () => {
    expect(advanceRecurring({ date: '2026-01-29', string: 'every 29 jan', lang: 'en', timezone: null, recurring: true }, '2026-01-29')?.date.slice(0, 10)).toBe('2027-01-29');
  });

  it('an abbreviated weekday in a monthly rule is read: "every last mon" from a last Monday of February', () => {
    expect(advanceRecurring({ date: '2026-02-23', string: 'every last mon', lang: 'en', timezone: null, recurring: true }, '2026-02-23')?.date.slice(0, 10)).toBe('2026-03-30');
  });

  it('"every 3 workdays" counts workdays, so a Friday moves on to the Wednesday three workdays later', () => {
    expect(advanceRecurring({ date: '2026-11-20', string: 'every 3 workdays', lang: 'en', timezone: null, recurring: true }, '2026-11-20')?.date.slice(0, 10)).toBe('2026-11-25');
  });

  it('"every 15th" keeps its day when it advances from a task moved to the 20th', () => {
    expect(advanceRecurring({ date: '2026-12-20', string: 'every 15th', lang: 'en', timezone: null, recurring: true }, '2026-12-20')?.date.slice(0, 10)).toBe('2027-01-15');
  });

  it('a start date that is not a day is refused, not a server error', () => {
    expect(() => resolveDue({ string: 'every day starting 2026-99-99', lang: 'en', is_recurring: true }, '2026-11-23')).toThrow(ApiFailure);
  });

  it('a due with a time must have a real time after its day', () => {
    expect(() => resolveDue({ date: '2026-11-23T99:99', lang: 'en', is_recurring: false }, '2026-11-23')).toThrow(ApiFailure);
    expect(resolveDue({ date: '2026-11-23T09:30', lang: 'en', is_recurring: false }, '2026-11-23')?.date).toBe('2026-11-23T09:30');
  });

  it('refuses a rule it cannot read, with a reason the app can show', () => {
    expect(() => parseRule('whenever it feels right')).toThrow(ApiFailure);
    try {
      parseRule('whenever it feels right');
    } catch (error) {
      expect((error as ApiFailure).tag).toBe('INVALID_DATE');
    }
  });
});

describe('moving a repeating task on', () => {
  const today = '2026-11-23';

  it('an overdue task moves to the next time its rule falls after today, not to a late day', () => {
    const next = advanceRecurring(due('2026-11-01', 'every day'), today);
    expect(next?.date).toBe('2026-11-24');
    const weekly = advanceRecurring(due('2026-11-02', 'every monday'), today);
    expect(weekly?.date).toBe('2026-11-30');
  });

  it('a task completed early moves on from its own date, not from today', () => {
    const next = advanceRecurring(due('2026-12-07', 'every monday'), today);
    expect(next?.date).toBe('2026-12-14');
  });

  it('“every!” counts from the day it was completed', () => {
    const next = advanceRecurring(due('2026-11-01', 'every! 3 days'), today);
    expect(next?.date).toBe('2026-11-26');
  });

  it('keeps the time of day of the task', () => {
    const next = advanceRecurring(due('2026-11-01T08:15:00', 'every day'), today);
    expect(next?.date).toBe('2026-11-24T08:15:00');
    const timed = advanceRecurring(due('2026-11-01', 'every day at 20:30'), today);
    expect(timed?.date).toBe('2026-11-24T20:30:00');
  });
});

describe('resolving a due from the app', () => {
  it('a date with no repeat is kept as it is', () => {
    expect(resolveDue({ date: '2026-12-01', string: 'tomorrow', lang: 'fr', is_recurring: false }, '2026-11-23')).toEqual({
      date: '2026-12-01', string: 'tomorrow', lang: 'fr', timezone: null, recurring: false,
    });
  });

  it('a repeat with no day starts on its first day, counted from today', () => {
    const resolved = resolveDue({ string: 'every monday', lang: 'en', is_recurring: true }, '2026-11-23');
    // 23 November 2026 is a Monday: a rule that starts today starts today.
    expect(resolved?.date).toBe('2026-11-23');
    expect(resolved?.recurring).toBe(true);
  });

  it('a repeat with a start in its text begins there', () => {
    const resolved = resolveDue({ string: 'every day starting 2026-12-05', lang: 'en', is_recurring: true }, '2026-11-23');
    expect(resolved?.date).toBe('2026-12-05');
  });

  it('a null due clears the date; a repeat with no rule, or a date that is not a day, is refused', () => {
    expect(resolveDue(null, '2026-11-23')).toBeNull();
    expect(() => resolveDue({ is_recurring: true, string: '' }, '2026-11-23')).toThrow(ApiFailure);
    expect(() => resolveDue({ is_recurring: false, date: '2026-02-31' }, '2026-11-23')).toThrow(ApiFailure);
    expect(() => resolveDue({ is_recurring: false }, '2026-11-23')).toThrow(ApiFailure);
  });
});
