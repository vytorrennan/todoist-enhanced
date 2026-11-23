import { apiUrl } from './client';

/**
 * The session the app signs in with.
 *
 * Signing in, or creating an account, gives a session token. It is kept on this
 * device and sent with every request, and it is revoked on the server when the
 * person signs out. This file is the only place that knows where it is kept.
 */

const TOKEN_KEY = 'tde.session';
/** Sessions signed out while offline, to be revoked on the server once it can be reached. */
const PENDING_KEY = 'tde.pendingLogouts';
const MAX_PENDING = 5;
const REVOKE_TIMEOUT_MS = 5_000;
const PAUSED_UNTIL_KEY = 'tde.logoutsPausedUntil';
const MAX_PASSES = 5;
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 10 * 60_000;

export interface AuthProvider {
  /** The bearer token to send, or null when nobody is signed in. */
  getToken(): Promise<string | null>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

class Auth implements AuthProvider {
  /* Only for a browser that blocks storage. Everywhere else the token is read
     from storage on every call: the desktop app runs the site in two windows
     at once, and a copy kept in memory at load let the Quick Add window go on
     sending with the account it opened on after the main window had signed in
     to another one. The device holds one session, and every window uses it. */
  private memory: string | null;

  constructor() {
    const stored = readStoredToken();
    this.memory = stored === undefined ? null : stored;
  }

  private get token(): string | null {
    const stored = readStoredToken();
    return stored === undefined ? this.memory : stored;
  }

  async getToken(): Promise<string | null> {
    return this.token || null;
  }

  isConnected(): boolean {
    return this.token !== null && this.token.length > 0;
  }

  set(token: string): void {
    this.memory = token.trim();
    try {
      localStorage.setItem(TOKEN_KEY, this.memory);
    } catch {
      // A browser with storage blocked still works for the session in memory.
    }
  }

  /**
   * Forgets the session on this device at once. It is revoked on the server in
   * the background: if the server cannot be reached now, the revocation waits
   * in this browser and is sent the next time the app starts online. Nothing
   * waits on it, so sign-out never blocks on the network.
   */
  async disconnect(): Promise<void> {
    const token = this.token;
    this.memory = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
    if (!token) return;
    queuePendingLogout(token);
    void flushPendingLogouts();
  }
}

function readPending(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writePending(tokens: string[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(tokens.slice(-MAX_PENDING)));
  } catch {
    /* storage blocked: the session expires on the server in time */
  }
}

function queuePendingLogout(token: string): void {
  writePending([...readPending().filter((item) => item !== token), token]);
}

/**
 * Revokes the sessions signed out here, while the server can be reached. Each
 * one is removed from the queue as soon as the server has answered for it (so
 * flushes that overlap never undo each other), and only ever retried later.
 * A session the server has already forgotten counts as revoked.
 */
let flushing: Promise<void> | null = null;

export function flushPendingLogouts(): Promise<void> {
  // Flushes that overlap in this window share one pass over the queue.
  flushing ??= exclusively(sendPendingLogouts).finally(() => { flushing = null; });
  return flushing;
}

/** When the server last asked for a pause, as a time; zero when it did not. */
function pausedUntil(): number {
  try {
    return Number(localStorage.getItem(PAUSED_UNTIL_KEY)) || 0;
  } catch {
    return 0;
  }
}

function pauseLogouts(ms: number): void {
  try {
    localStorage.setItem(PAUSED_UNTIL_KEY, String(Date.now() + Math.min(Math.max(ms, 0), MAX_PAUSE_MS)));
  } catch {
    /* storage blocked: the next trigger asks again, which the server answers the same way */
  }
}

/** The pause the server asked for, from Retry-After in seconds; a default when it gave none. */
function pauseFrom(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_PAUSE_MS;
}

/** One flush at a time across the windows of this browser, where the browser offers a lock. */
function exclusively(work: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined;
  return locks ? locks.request<void>('tde.logouts', () => work()) : work();
}

async function sendPendingLogouts(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  // A pass goes on while sign-outs queued during it are still waiting, up to a limit on passes.
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const batch = readPending();
    if (batch.length === 0) return;
    for (const token of batch) {
      // Read before every request: another window may have been told to stop.
      if (Date.now() < pausedUntil()) return;
      try {
        const response = await fetch(apiUrl('/auth/logout'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          keepalive: true,
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        });
        if (response.ok || response.status === 401) {
          writePending(readPending().filter((item) => item !== token));
        } else {
          // Anything but an answer (a pause, a failure, a proxy's refusal) ends the pass; nothing more is sent until the pause has passed.
          pauseLogouts(pauseFrom(response));
          return;
        }
      } catch {
        // Offline or unreachable: everything still queued waits for the next connection.
        return;
      }
    }
  }
}

let listeningForOnline = false;

/** Sends the waiting revocations as soon as the browser reports a connection again. Registered once. */
export function sendLogoutsWhenOnline(): void {
  if (listeningForOnline || typeof window?.addEventListener !== 'function') return;
  listeningForOnline = true;
  window.addEventListener('online', () => void flushPendingLogouts());
}

/** The stored token, null when there is none, undefined when storage is blocked. */
function readStoredToken(): string | null | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return undefined;
  }
}

export const auth = new Auth();
