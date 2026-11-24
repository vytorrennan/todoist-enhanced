import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../app';
import { resetLoginAttempts } from '../auth';
import { resetBudgets } from '../http';

export interface TestServer {
  base: string;
  app: App;
  dir: string;
  close(): Promise<void>;
}

/** A real HTTP server on a random port, with its own database in a temporary folder. */
export async function startServer(options: { signup?: boolean; staticDir?: string } = {}): Promise<TestServer> {
  resetLoginAttempts();
  resetBudgets();
  const dir = mkdtempSync(join(tmpdir(), 'tde-test-'));
  const app = createApp({ database: join(dir, 'test.db'), dataDir: dir, signup: options.signup ?? true, staticDir: options.staticDir });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    app,
    dir,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Person {
  email: string;
  token: string;
  id: string;
  inbox: string;
}

export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Calls the API as a person would, with the bearer token. */
export class Api {
  constructor(readonly base: string, readonly token: string | null = null) {}

  as(token: string): Api {
    return new Api(this.base, token);
  }

  async call<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers, body: payload });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(path: string) { return this.call<T>('GET', path); }
  post<T = any>(path: string, body?: unknown) { return this.call<T>('POST', path, body ?? {}); }

  private accountId: string | null = null;

  /**
   * A token written as a bare sequence number is turned into the account's own
   * token (`<account>:<sequence>`), as the app would have kept it.
   */
  private async boundToken(token: string | undefined): Promise<string> {
    if (token === undefined || token === '*' || token.includes(':') || !/^\d+$/.test(token)) return token ?? '*';
    if (!this.accountId) {
      const me = await this.call<{ user: { id: string } }>('GET', '/api/v1/auth/me');
      this.accountId = me.body.user.id;
    }
    return `${this.accountId}:${token}`;
  }

  /** One sync request. Commands are sent the way the app sends them: a JSON string in a form. */
  async sync(options: { token?: string; types?: string[]; commands?: unknown[] } = {}) {
    const form = new URLSearchParams({ sync_token: await this.boundToken(options.token) });
    form.set('resource_types', JSON.stringify(options.types ?? ['items', 'projects', 'sections', 'labels', 'notes', 'project_notes', 'user', 'collaborators', 'collaborator_states', 'workspaces', 'live_notifications', 'filters', 'completed_info', 'user_settings']));
    if (options.commands) form.set('commands', JSON.stringify(options.commands));
    return this.form('/api/v1/sync', form);
  }

  async form(path: string, form: URLSearchParams): Promise<Reply<any>> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.base + path, { method: 'POST', headers, body: form.toString() });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }
}

let counter = 0;
/** A new person with an account. Each call makes a new address. */
export async function person(api: Api, name = 'Test person'): Promise<Person> {
  counter += 1;
  const email = `person${counter}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reply = await api.call('POST', '/api/v1/auth/register', { email, password: 'a-long-password', full_name: name, timezone: 'UTC' });
  if (reply.status !== 201) throw new Error(`register failed: ${reply.status} ${JSON.stringify(reply.body)}`);
  return { email, token: reply.body.token, id: reply.body.user.id, inbox: reply.body.user.inbox_project_id };
}

/** A temporary id in the app's own form: a dashed uuid. */
export const tempId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let uuidCounter = 0;
export const uuid = (): string => `11111111-2222-4333-8444-${String(Date.now()).slice(-6)}${String(++uuidCounter).padStart(6, '0')}`;
export const command = (type: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type, uuid: uuid(), args, ...extra });
