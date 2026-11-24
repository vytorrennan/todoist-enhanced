import { ApiFailure } from './db';
import type { UserRow } from './auth';
import { isDay, todayIn } from './dates';
import { readNaturalDate } from '../src/domain/nlp';
import { ruleFromString } from '../src/domain/repeatRule';

/**
 * A due a person typed in words, read the way the app reads it. Both the REST API (`due_string`) and the Sync API
 * (`due.string`) take one, so both use this.
 *
 * A repeat rule is kept as written. A day written as `2030-01-15` is that day. Anything else is read as one day,
 * counted from the viewer's today.
 */
export function dueFromWords(words: string, viewer: UserRow): { date?: string; string: string; is_recurring?: boolean } {
  if (ruleFromString(words) && /\b(every|tous les|chaque|tout les)\b/i.test(words)) {
    return { string: words, is_recurring: true };
  }
  if (isDay(words)) return { date: words, string: words };
  const reading = readNaturalDate(words, new Date(`${todayIn(viewer.timezone)}T12:00:00`), { locale: viewer.lang === 'fr' ? 'fr' : 'en' });
  if (!reading) throw ApiFailure.badRequest(`“${words}” is not a date the server can read.`, 'INVALID_DATE');
  return { date: reading.date, string: words };
}

/**
 * A due sent by a Sync command. Words with no day or rule of their own are read the same way the REST API reads
 * them, so the Sync API and the REST API agree on what "tomorrow" means.
 */
export function dueFromCommand(due: unknown, viewer: UserRow): unknown {
  if (!due || typeof due !== 'object') return due;
  const input = due as Record<string, unknown>;
  if (typeof input.string !== 'string' || typeof input.date === 'string' || input.is_recurring === true) return due;
  const words = input.string.trim();
  if (!words) return due;
  return { ...input, ...dueFromWords(words, viewer) };
}
