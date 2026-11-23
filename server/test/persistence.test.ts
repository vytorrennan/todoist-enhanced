import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app';
import { Api, command, tempId } from './harness';
import { MIGRATIONS } from '../schema';

/**
 * The database is a file: what is written is what is there after a restart,
 * and opening it again must neither lose anything nor run a migration twice.
 */
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

async function listen(app: ReturnType<typeof createApp>) {
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

describe('the database on disk', () => {
  it('keeps accounts, tasks, comments and sessions across a restart, and the schema version is stable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tde-persist-'));
    dirs.push(dir);
    const file = join(dir, 'enhanced.db');

    const first = createApp({ database: file, dataDir: dir });
    const base = await listen(first);
    const api = new Api(base);
    const reg = await api.post('/api/v1/auth/register', { email: 'keep@example.com', password: 'a long password', full_name: 'Keep' });
    const token = reg.body.token as string;
    const mine = new Api(base, token);
    const made = await mine.sync({ commands: [command('item_add', { content: 'Survives', project_id: reg.body.user.inbox_project_id }, { temp_id: tempId(1) })] });
    const realId = made.body.temp_id_mapping[tempId(1)] as string;
    await mine.sync({ commands: [command('note_add', { item_id: realId, content: 'A note' })] });
    await first.close();

    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);

    const second = createApp({ database: file, dataDir: dir });
    const again = await listen(second);
    try {
      const back = await new Api(again, token).sync({});
      expect(back.status).toBe(200);
      expect(back.body.items.map((i: { content: string }) => i.content)).toEqual(['Survives']);
      const notes = await new Api(again, token).get(`/api/v1/comments?task_id=${realId}`);
      expect(notes.body.results.map((n: { content: string }) => n.content)).toEqual(['A note']);
      const signIn = await new Api(again).post('/api/v1/auth/login', { email: 'keep@example.com', password: 'a long password' });
      expect(signIn.status).toBe(200);
      const version = second.db.pragma('user_version', { simple: true }) as number;
      expect(version).toBe(MIGRATIONS.length);
    } finally {
      await second.close();
    }

    // Opening it a third time runs nothing again and loses nothing.
    const third = createApp({ database: file, dataDir: dir });
    const once = await listen(third);
    try {
      const count = (third.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
      expect(count).toBe(1);
      expect((await new Api(once, token).sync({})).body.items).toHaveLength(1);
    } finally {
      await third.close();
    }
  });

  it('refuses a database written by a newer server rather than damaging it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tde-newer-'));
    dirs.push(dir);
    const file = join(dir, 'enhanced.db');
    const first = createApp({ database: file, dataDir: dir });
    first.db.pragma(`user_version = ${MIGRATIONS.length + 5}`);
    await first.close();
    expect(() => createApp({ database: file, dataDir: dir })).toThrow(/newer version/);
  });
});
