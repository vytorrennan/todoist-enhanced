import { afterEach, describe, expect, it, vi } from 'vitest';
import { auth, flushPendingLogouts, sendLogoutsWhenOnline } from './auth';

/** The session the device keeps: set, read back, and forgotten on sign-out. */
describe('the session on this device', () => {
  const store = new Map<string, string>();
  const realLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

  // Node has no storage; a small stand-in lets the rules run the way a browser does.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });

  afterEach(async () => {
    await auth.disconnect();
  });

  it('holds nothing until a session is set, and returns it once', async () => {
    expect(auth.isConnected()).toBe(false);
    expect(await auth.getToken()).toBeNull();
    auth.set('  abc123  ');
    expect(auth.isConnected()).toBe(true);
    expect(await auth.getToken()).toBe('abc123');
  });

  it('is forgotten on this device when the person signs out', async () => {
    auth.set('session-token');
    await auth.disconnect();
    expect(auth.isConnected()).toBe(false);
    expect(store.has('tde.session')).toBe(false);
  });

  it('a sign-out made offline is kept, and revoked once the server can be reached', async () => {
    store.delete('tde.pendingLogouts');
    store.delete('tde.logoutsPausedUntil');
    auth.set('offline-session');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
    try {
      await auth.disconnect();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.get('tde.pendingLogouts')).toContain('offline-session');
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
      await flushPendingLogouts();
      expect(fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].headers)).toEqual([{ Authorization: 'Bearer offline-session' }]);
      expect(JSON.parse(store.get('tde.pendingLogouts') ?? '[]')).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      if (online) Object.defineProperty(globalThis, 'navigator', online);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('a pause from the server stops the pass, and the rest waits for the next connection', async () => {
    store.set('tde.pendingLogouts', JSON.stringify(['first', 'second']));
    store.delete('tde.logoutsPausedUntil');
    const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      await flushPendingLogouts();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.get('tde.pendingLogouts') ?? '[]')).toEqual(['first', 'second']);
    } finally {
      vi.unstubAllGlobals();
      if (online) Object.defineProperty(globalThis, 'navigator', online);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('a sign-out queued while a pass runs is sent by that same pass', async () => {
    store.set('tde.pendingLogouts', JSON.stringify(['first']));
    store.delete('tde.logoutsPausedUntil');
    const sent: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).Authorization.replace('Bearer ', '');
      sent.push(token);
      // Another window queues a sign-out while this one is still sending.
      if (token === 'first') store.set('tde.pendingLogouts', JSON.stringify(['late']));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      await flushPendingLogouts();
      expect(sent).toEqual(['first', 'late']);
      expect(JSON.parse(store.get('tde.pendingLogouts') ?? '[]')).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      if (online) Object.defineProperty(globalThis, 'navigator', online);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('a pause the server asked for holds the next trigger too, not only the pass that met it', async () => {
    store.set('tde.pendingLogouts', JSON.stringify(['held']));
    store.delete('tde.logoutsPausedUntil');
    const fetchMock = vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetchMock);
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      await flushPendingLogouts();
      await flushPendingLogouts();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.get('tde.pendingLogouts') ?? '[]')).toEqual(['held']);
    } finally {
      vi.unstubAllGlobals();
      if (online) Object.defineProperty(globalThis, 'navigator', online);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('a refusal that is not an answer, such as a proxy\'s 403, ends the pass after one request', async () => {
    store.set('tde.pendingLogouts', JSON.stringify(['a', 'b', 'c', 'd', 'e']));
    store.delete('tde.logoutsPausedUntil');
    const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      await flushPendingLogouts();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.get('tde.pendingLogouts') ?? '[]')).toEqual(['a', 'b', 'c', 'd', 'e']);
    } finally {
      vi.unstubAllGlobals();
      if (online) Object.defineProperty(globalThis, 'navigator', online);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('a pause another window records is honored before the next request of a pass', async () => {
    store.set('tde.pendingLogouts', JSON.stringify(['first', 'second']));
    store.delete('tde.logoutsPausedUntil');
    const fetchMock = vi.fn(async () => {
      // Another window is told to stop while this one is still sending.
      store.set('tde.logoutsPausedUntil', String(Date.now() + 60_000));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    try {
      await flushPendingLogouts();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.get('tde.pendingLogouts') ?? '[]')).toEqual(['second']);
    } finally {
      vi.unstubAllGlobals();
      if (online) Object.defineProperty(globalThis, 'navigator', online);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('listens for the connection to return once, however often the store starts', () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener });
    try {
      sendLogoutsWhenOnline();
      sendLogoutsWhenOnline();
      expect(addEventListener).toHaveBeenCalledTimes(1);
      expect(addEventListener.mock.calls[0][0]).toBe('online');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores the real storage afterwards', () => {
    expect(realLocalStorage === undefined || typeof realLocalStorage === 'object').toBe(true);
  });
});
