import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { MIGRATIONS } from './schema';

export type Db = Database.Database;

/**
 * Opens the database file (or an in-memory one for tests), turns on the
 * pragmas the server relies on, and brings the schema up to date.
 */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`The database is from a newer version (schema ${current}, this server knows ${MIGRATIONS.length}).`);
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/** A new identifier. No dashes: a dashed id is the app's own temporary one. */
export const newId = (): string => randomBytes(16).toString('hex');

/** The next value of the global change counter. */
export function nextSeq(db: Db): number {
  const row = db.prepare('UPDATE meta SET value = value + 1 WHERE key = ? RETURNING value').get('seq') as { value: number };
  return row.value;
}

export function currentSeq(db: Db): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('seq') as { value: number };
  return row.value;
}

/** Times are ISO 8601 in UTC, to the millisecond, everywhere in the database. */
export const nowIso = (): string => new Date().toISOString();

/** Errors that reach the client, with the status and tag Todoist-style clients read. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly tag: string,
    readonly code: number = status,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }

  static badRequest(message: string, tag = 'INVALID_ARGUMENT'): ApiFailure {
    return new ApiFailure(400, message, tag);
  }

  static unauthorized(message = 'Sign in to continue.'): ApiFailure {
    return new ApiFailure(401, message, 'UNAUTHORIZED');
  }

  static forbidden(message = 'You do not have access to that.', tag = 'FORBIDDEN'): ApiFailure {
    return new ApiFailure(403, message, tag);
  }

  static notFound(message = 'Not found.', tag = 'NOT_FOUND'): ApiFailure {
    return new ApiFailure(404, message, tag);
  }

  static conflict(message: string, tag = 'CONFLICT'): ApiFailure {
    return new ApiFailure(409, message, tag);
  }
}
