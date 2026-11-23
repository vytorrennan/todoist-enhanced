import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiFailure, type Db, newId, nextSeq, nowIso } from './db';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;

/** How long a sign-in lasts. Nothing refreshes it: after this, sign in again. */
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 256;

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  inbox_project_id: string;
  timezone: string;
  lang: string;
  start_day: number;
  reset_recurring_subtasks: number;
  image_id: string | null;
  access_seq: number;
  created_at: string;
  seq: number;
}

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The hash a session token is stored under. The token itself is never kept. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const normalizeEmail = (raw: unknown): string => {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw ApiFailure.badRequest('Enter a valid email address.', 'INVALID_EMAIL');
  }
  return email;
};

export function validatePassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < MIN_PASSWORD) {
    throw ApiFailure.badRequest(`A password needs at least ${MIN_PASSWORD} characters.`, 'WEAK_PASSWORD');
  }
  if (raw.length > MAX_PASSWORD) throw ApiFailure.badRequest('That password is too long.', 'WEAK_PASSWORD');
  return raw;
}

export function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, 120) : '';
}

/** A timezone the runtime knows, or UTC. */
export function cleanTimezone(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw.trim() });
    return raw.trim();
  } catch {
    return null;
  }
}

/**
 * Creates the account, its Inbox, and the claim on every invitation that was
 * sent to its address before it existed.
 */
export async function registerUser(
  db: Db,
  input: { email: unknown; password: unknown; full_name?: unknown; timezone?: unknown; lang?: unknown },
): Promise<UserRow> {
  const email = normalizeEmail(input.email);
  const password = validatePassword(input.password);
  const taken = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (taken) throw ApiFailure.conflict('An account already uses that email address.', 'EMAIL_TAKEN');
  const passwordHash = await hashPassword(password);
  const id = newId();
  const seq = nextSeq(db);
  const now = nowIso();
  const timezone = cleanTimezone(input.timezone) ?? 'UTC';
  const lang = input.lang === 'fr' ? 'fr' : 'en';
  return db.transaction(() => {
    const inboxId = newId();
    db.prepare(`INSERT INTO users (id, email, full_name, password_hash, inbox_project_id, timezone, lang, created_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, email, cleanName(input.full_name), passwordHash, inboxId, timezone, lang, now, seq);
    db.prepare(`INSERT INTO projects (id, name, color, is_inbox, created_by, created_at, seq)
      VALUES (?, 'Inbox', 'charcoal', 1, ?, ?, ?)`).run(inboxId, id, now, nextSeq(db));
    db.prepare(`INSERT INTO project_members (project_id, user_id, role, joined_at, seq)
      VALUES (?, ?, 'CREATOR', ?, ?)`).run(inboxId, id, now, nextSeq(db));
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  })();
}

/** Checks an email and password. Null when either is wrong: the reason is never said. */
export async function checkLogin(db: Db, email: string, password: string): Promise<UserRow | null> {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as UserRow | undefined;
  if (!user) {
    // Spend the same time as a real check, so a missing account is not quicker to refuse.
    await verifyPassword(password, `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`);
    return null;
  }
  if (!(await verifyPassword(password, user.password_hash))) return null;
  // The check took time: a password changed meanwhile is not the one that was checked.
  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string } | undefined;
  return stored?.password_hash === user.password_hash ? user : null;
}

/** A new session. Returns the token once; only its hash is kept. */
export function createSession(db: Db, userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, new Date(now).toISOString(), expiresAt);
  return { token, expiresAt };
}

/** The user a token belongs to, or null for an unknown or expired one. */
export function userForToken(db: Db, token: string | null | undefined): UserRow | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), nowIso()) as UserRow | undefined;
  return row ?? null;
}

export function revokeSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function revokeOtherSessions(db: Db, userId: string, keepToken: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hashToken(keepToken));
}

/** Per-address limits on sign-in attempts, so a password cannot be guessed at speed. */
const attempts = new Map<string, number[]>();
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_LIMIT = 10;

/** Seconds until another attempt is allowed, or 0 when one is allowed now. */
export function loginWait(key: string, now = Date.now()): number {
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
  attempts.set(key, recent);
  if (recent.length < LOGIN_LIMIT) return 0;
  return Math.ceil((recent[0] + LOGIN_WINDOW_MS - now) / 1000);
}

export function recordLoginAttempt(key: string, now = Date.now()): void {
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
}

export function clearLoginAttempts(key: string): void {
  attempts.delete(key);
}

/** For tests: forget every recorded attempt. */
export function resetLoginAttempts(): void {
  attempts.clear();
}
