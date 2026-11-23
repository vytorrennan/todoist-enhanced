import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, command, person, startServer, type TestServer, tempId } from './harness';
import { SESSION_DAYS } from '../auth';

let server: TestServer;
let api: Api;

beforeAll(async () => {
  server = await startServer();
  api = new Api(server.base);
});
afterAll(async () => server.close());

describe('accounts and sessions', () => {
  it('creates an account with an inbox, and signs in with it', async () => {
    const email = 'new.person@example.com';
    const reg = await api.post('/api/v1/auth/register', { email, password: 'long enough', full_name: '  Ada  ', timezone: 'Europe/Paris', lang: 'fr' });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ email, full_name: 'Ada', lang: 'fr', is_premium: true, karma: null });
    expect(reg.body.user.tz_info.timezone).toBe('Europe/Paris');
    expect(reg.body.user.inbox_project_id).toMatch(/^[0-9a-f]{32}$/);
    expect(reg.body.token).toBeTypeOf('string');
    const login = await api.post('/api/v1/auth/login', { email: 'NEW.PERSON@example.com ', password: 'long enough' });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(reg.body.user.id);
  });

  it('refuses a second account on the same address, whatever its case', async () => {
    const reply = await api.post('/api/v1/auth/register', { email: 'DUP@example.com', password: 'long enough' });
    expect(reply.status).toBe(201);
    const again = await api.post('/api/v1/auth/register', { email: 'dup@example.com', password: 'another long one' });
    expect(again.status).toBe(409);
    expect(again.body.error_tag).toBe('EMAIL_TAKEN');
  });

  it('validates the address and the password', async () => {
    expect((await api.post('/api/v1/auth/register', { email: 'not-an-email', password: 'long enough' })).body.error_tag).toBe('INVALID_EMAIL');
    expect((await api.post('/api/v1/auth/register', { email: 'ok@example.com', password: 'short' })).body.error_tag).toBe('WEAK_PASSWORD');
    expect((await api.post('/api/v1/auth/register', { email: 'ok2@example.com', password: 'x'.repeat(300) })).body.error_tag).toBe('WEAK_PASSWORD');
    expect((await api.post('/api/v1/auth/register', { email: 'x'.repeat(260) + '@e.co', password: 'long enough' })).body.error_tag).toBe('INVALID_EMAIL');
  });

  it('answers a wrong password and an unknown address the same way', async () => {
    const reply = await api.post('/api/v1/auth/register', { email: 'known@example.com', password: 'long enough' });
    expect(reply.status).toBe(201);
    const wrong = await api.post('/api/v1/auth/login', { email: 'known@example.com', password: 'not the password' });
    const unknown = await api.post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks sign-in for an address after repeated wrong passwords, with Retry-After', async () => {
    await api.post('/api/v1/auth/register', { email: 'locked@example.com', password: 'long enough' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await api.post('/api/v1/auth/login', { email: 'locked@example.com', password: 'wrong wrong' });
    }
    const blocked = await api.post('/api/v1/auth/login', { email: 'locked@example.com', password: 'long enough' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error_tag).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rejects requests with no token, a made-up token, and a token after sign-out', async () => {
    const who = await person(api);
    expect((await api.get('/api/v1/auth/me')).status).toBe(401);
    expect((await new Api(server.base, 'not-a-token').get('/api/v1/auth/me')).status).toBe(401);
    const mine = new Api(server.base, who.token);
    expect((await mine.get('/api/v1/auth/me')).status).toBe(200);
    expect((await mine.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await mine.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('refuses a session that has run out', async () => {
    const who = await person(api);
    const { db } = server.app;
    const past = new Date(Date.now() - (SESSION_DAYS + 1) * 86_400_000).toISOString();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(past, who.id);
    expect((await new Api(server.base, who.token).get('/api/v1/auth/me')).status).toBe(401);
  });

  it('changes the password, and signs out the other sessions only', async () => {
    const who = await person(api);
    const first = new Api(server.base, who.token);
    const second = await api.post('/api/v1/auth/login', { email: who.email, password: 'a-long-password' });
    const wrongCurrent = await first.post('/api/v1/auth/password', { current_password: 'nope nope', new_password: 'brand new one' });
    expect(wrongCurrent.status).toBe(403);
    const changed = await first.post('/api/v1/auth/password', { current_password: 'a-long-password', new_password: 'brand new one' });
    expect(changed.status).toBe(204);
    expect((await new Api(server.base, second.body.token).get('/api/v1/auth/me')).status).toBe(401);
    expect((await first.get('/api/v1/auth/me')).status).toBe(200);
    expect((await api.post('/api/v1/auth/login', { email: who.email, password: 'brand new one' })).status).toBe(200);
  });

  it('can be turned off by the operator', async () => {
    const closed = await startServer({ signup: false });
    try {
      const reply = await new Api(closed.base).post('/api/v1/auth/register', { email: 'a@example.com', password: 'long enough' });
      expect(reply.status).toBe(403);
      expect(reply.body.error_tag).toBe('SIGNUP_CLOSED');
      expect((await new Api(closed.base).get('/api/v1/auth/config')).body.signup).toBe(false);
    } finally {
      await closed.close();
    }
  });

  it('lets the person change their name, timezone and language, and refuses nonsense', async () => {
    const who = await person(api);
    const mine = new Api(server.base, who.token);
    const ok = await mine.call('POST', '/api/v1/auth/me', { full_name: 'New name', timezone: 'America/New_York', lang: 'fr', start_day: 7 });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ full_name: 'New name', lang: 'fr', start_day: 7 });
    expect(ok.body.user.tz_info.timezone).toBe('America/New_York');
    expect((await mine.call('POST', '/api/v1/auth/me', { timezone: 'Mars/Olympus' })).body.error_tag).toBe('INVALID_TIMEZONE');
    expect((await mine.call('POST', '/api/v1/auth/me', { lang: 'de' })).body.error_tag).toBe('INVALID_LANGUAGE');
  });
});

describe('sync reads', () => {
  it('a full read returns the inbox and the person, and the token moves forward', async () => {
    const who = await person(api);
    const reply = await new Api(server.base, who.token).sync({});
    expect(reply.status).toBe(200);
    expect(reply.body.full_sync).toBe(true);
    expect(reply.body.projects.map((p: { id: string }) => p.id)).toEqual([who.inbox]);
    expect(reply.body.projects[0]).toMatchObject({ inbox_project: true, role: 'CREATOR', is_shared: false });
    expect(reply.body.user.id).toBe(who.id);
    expect(reply.body.sync_token).toMatch(/^[0-9a-f]{32}:\d+$/);
    expect(reply.body.user_settings).toEqual({ reset_recurring_subtasks: false });
  });

  it('an incremental read returns only what changed, and deleted tasks come back as tombstones', async () => {
    const who = await person(api);
    const mine = new Api(server.base, who.token);
    const first = await mine.sync({});
    const made = await mine.sync({ token: first.body.sync_token, commands: [command('item_add', { content: 'One', project_id: who.inbox }, { temp_id: tempId(1) })] });
    const realId = made.body.temp_id_mapping[tempId(1)];
    expect(made.body.items.map((i: { id: string }) => i.id)).toEqual([realId]);
    const quiet = await mine.sync({ token: made.body.sync_token });
    expect(quiet.body.items).toEqual([]);
    expect(quiet.body.full_sync).toBe(false);
    await mine.sync({ token: quiet.body.sync_token, commands: [command('item_delete', { id: realId })] });
    const after = await mine.sync({ token: made.body.sync_token });
    expect(after.body.items).toEqual([expect.objectContaining({ id: realId, is_deleted: true })]);
  });

  it('a token it did not issue is refused, and a token from the future gets a full read', async () => {
    const who = await person(api);
    const mine = new Api(server.base, who.token);
    const bad = await mine.sync({ token: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.error_tag).toBe('INVALID_SYNC_TOKEN');
    const future = await mine.sync({ token: '999999999999' });
    expect(future.body.full_sync).toBe(true);
  });

  it('a retried command is answered from the first time and changes nothing twice', async () => {
    const who = await person(api);
    const mine = new Api(server.base, who.token);
    const add = { type: 'item_add', uuid: 'fixed-uuid-retry-0000000000000001', args: { content: 'Once', project_id: who.inbox }, temp_id: tempId(7) };
    const first = await mine.sync({ commands: [add] });
    const second = await mine.sync({ commands: [add] });
    expect(first.body.sync_status['fixed-uuid-retry-0000000000000001']).toBe('ok');
    expect(second.body.sync_status['fixed-uuid-retry-0000000000000001']).toBe('ok');
    const all = await mine.sync({});
    expect(all.body.items.filter((i: { content: string }) => i.content === 'Once')).toHaveLength(1);
  });

  it('a command the server does not know is refused alone, and the rest still go through', async () => {
    const who = await person(api);
    const mine = new Api(server.base, who.token);
    const reply = await mine.sync({
      commands: [
        command('item_add', { content: 'Kept', project_id: who.inbox }),
        command('teleport_task', { id: 'x' }),
      ],
    });
    const statuses = Object.values(reply.body.sync_status) as Array<string | { error_tag: string }>;
    expect(statuses).toContain('ok');
    expect(statuses.find((s) => typeof s !== 'string')).toMatchObject({ error_tag: 'UNKNOWN_COMMAND', error_code: 400 });
    const all = await mine.sync({});
    expect(all.body.items.map((i: { content: string }) => i.content)).toEqual(['Kept']);
  });

  it('refuses more commands than one request may carry', async () => {
    const who = await person(api);
    const commands = Array.from({ length: 501 }, () => command('item_add', { content: 'x', project_id: who.inbox }));
    const reply = await new Api(server.base, who.token).sync({ commands });
    expect(reply.status).toBe(400);
    expect(reply.body.error_tag).toBe('TOO_MANY_COMMANDS');
  });

  it('refuses a body that is not JSON', async () => {
    const who = await person(api);
    const res = await fetch(`${server.base}/api/v1/auth/me`, { method: 'POST', headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
  });
});
