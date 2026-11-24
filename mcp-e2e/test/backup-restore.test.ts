/* eslint-disable @typescript-eslint/no-explicit-any -- tool and API replies are untyped JSON; each test asserts the fields it reads. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Account, call, command, connectAssistant, createThrough, register, removeDir, RunningServer, scratchDir, startServer, sync } from './support.js';

/*
 * The recovery procedure in docs/deploying.md, run end to end: the database is backed up with SQLite's own backup
 * while the server is writing, the uploaded files are copied after it, and both are restored into a fresh server
 * process. Everything that was acknowledged before the backup started must be there, and each person must still
 * see only their own data.
 */

const sqlite = (database: string, statement: string): string =>
  execFileSync('sqlite3', [database, statement], { encoding: 'utf8' }).trim();

async function read(base: string, token: string, types: string[]): Promise<any> {
  const form = new URLSearchParams({ sync_token: '*', resource_types: JSON.stringify(types) });
  const reply = await fetch(`${base}/api/v1/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return reply.json();
}

async function upload(base: string, token: string, name: string, bytes: Buffer): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'text/plain' }), name);
  const reply = await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  if (reply.status !== 201) throw new Error(`The upload failed: ${reply.status} ${await reply.text()}`);
  return reply.json() as Promise<Record<string, unknown>>;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const RECEIPT = Buffer.from('Receipt 1042\nOat milk x2\nTotal 6.40\n');

interface Seeded {
  alice: Account;
  bob: Account;
  carol: Account;
  home: string;
  errands: string;
  buyMilk: string;
  oatMilk: string;
  work: string;
  draft: string;
  comment: string;
  fileId: string;
  /** Tasks the writer had been told were saved before the backup started. */
  acknowledged: string[];
}

let root: string;
let original: RunningServer;
let restored: RunningServer;
let seeded: Seeded;
let restoredIntegrity = '';
let restoredForeignKeys = '';

const makeDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  // sqlite3 is the same tool docs/deploying.md uses to back up. Without it, the procedure cannot be tested.
  execFileSync('sqlite3', ['-version'], { encoding: 'utf8' });

  root = scratchDir('backup');
  const sourceDir = makeDir(join(root, 'live'));
  const backupDir = makeDir(join(root, 'backup'));
  const restoredDir = join(root, 'restored');

  original = await startServer(sourceDir);
  const alice = await register(original.base, 'Alice');
  const bob = await register(original.base, 'Bob');
  const carol = await register(original.base, 'Carol');

  // Alice: a project, a section, a task with a subtask and a label, and a comment that carries an uploaded file.
  const home = await createThrough(original.base, alice.token, 'project_add', { name: 'Home' });
  const errands = await createThrough(original.base, alice.token, 'section_add', { name: 'Errands', project_id: home });
  const buyMilk = await createThrough(original.base, alice.token, 'item_add', {
    content: 'Buy milk', project_id: home, section_id: errands, labels: ['urgent'], due: { date: '2030-02-01' },
  });
  const oatMilk = await createThrough(original.base, alice.token, 'item_add', { content: 'Oat milk', project_id: home, parent_id: buyMilk });
  const uploaded = await upload(original.base, alice.token, 'receipt.txt', RECEIPT);
  const comment = await createThrough(original.base, alice.token, 'note_add', {
    item_id: buyMilk, content: 'Receipt attached', file_attachment: uploaded,
  });

  // Bob: a project of his own, and a task in it.
  const work = await createThrough(original.base, bob.token, 'project_add', { name: 'Work' });
  const draft = await createThrough(original.base, bob.token, 'item_add', { content: 'Draft report', project_id: work });

  // The writer keeps saving Alice's tasks while the backup runs. Each task it saves is acknowledged by the server.
  const acknowledged: string[] = [];
  let writing = true;
  const writer = (async () => {
    for (let n = 0; writing; n += 1) {
      const temp = randomUUID();
      const reply = await sync(original.base, alice.token, [command('item_add', { content: `Background ${n}`, project_id: home }, temp)]);
      const id = reply.body?.temp_id_mapping?.[temp];
      if (typeof id === 'string') acknowledged.push(id);
    }
  })();
  for (const started = Date.now(); acknowledged.length < 25; ) {
    if (Date.now() - started > 30_000) throw new Error('The writer did not get tasks saved in time.');
    await new Promise((done) => setTimeout(done, 20));
  }

  // The backup, as docs/deploying.md has it: the database with SQLite's backup, then the files it refers to.
  const acknowledgedBeforeBackup = [...acknowledged];
  const backupDatabase = join(backupDir, 'enhanced.db');
  execFileSync('sqlite3', [join(sourceDir, 'enhanced.db'), `.backup '${backupDatabase}'`], { encoding: 'utf8' });
  cpSync(join(sourceDir, 'files'), join(backupDir, 'files'), { recursive: true });

  writing = false;
  await writer;
  await original.stop();

  // Restore into a fresh folder, in a fresh server process.
  copyFileSync(backupDatabase, join(makeDir(restoredDir), 'enhanced.db'));
  cpSync(join(backupDir, 'files'), join(restoredDir, 'files'), { recursive: true });
  restoredIntegrity = sqlite(join(restoredDir, 'enhanced.db'), 'PRAGMA integrity_check;');
  restoredForeignKeys = sqlite(join(restoredDir, 'enhanced.db'), 'PRAGMA foreign_key_check;');
  restored = await startServer(restoredDir);

  seeded = {
    alice, bob, carol, home, errands, buyMilk, oatMilk, work, draft, comment,
    fileId: String(uploaded.id), acknowledged: acknowledgedBeforeBackup,
  };
}, 180_000);

afterAll(async () => {
  await restored?.stop();
  await original?.stop();
  if (root) removeDir(root);
});

describe('a backup taken while the server writes, restored into a fresh server', () => {
  it('passes SQLite’s integrity and foreign-key checks', () => {
    expect(restoredIntegrity).toBe('ok');
    expect(restoredForeignKeys).toBe('');
    expect(existsSync(join(root, 'restored', 'files'))).toBe(true);
  });

  it('keeps every account, and each person signs in with the same token', async () => {
    for (const person of [seeded.alice, seeded.bob, seeded.carol]) {
      const me = await fetch(`${restored.base}/api/v1/user`, { headers: { authorization: `Bearer ${person.token}` } });
      expect(me.status).toBe(200);
      expect((await me.json()).id).toBe(person.id);
    }
  });

  it('keeps every task that was saved before the backup started, with its project, section, parent and label', async () => {
    const aliceRead = await read(restored.base, seeded.alice.token, ['items', 'projects', 'sections', 'labels']);
    const items = new Map<string, any>(aliceRead.items.map((item: any) => [item.id, item]));
    expect(seeded.acknowledged.length).toBeGreaterThanOrEqual(25);
    for (const id of seeded.acknowledged) expect(items.has(id)).toBe(true);

    const buy = items.get(seeded.buyMilk);
    expect(buy).toMatchObject({ content: 'Buy milk', project_id: seeded.home, section_id: seeded.errands, due: expect.objectContaining({ date: '2030-02-01' }) });
    expect(buy.labels).toEqual(['urgent']);
    expect(items.get(seeded.oatMilk)).toMatchObject({ content: 'Oat milk', parent_id: seeded.buyMilk, project_id: seeded.home });
    expect(aliceRead.projects.map((project: any) => project.name)).toContain('Home');
    expect(aliceRead.sections.map((section: any) => section.name)).toContain('Errands');
  });

  it('keeps the comment and the file it carries, and gives the file only to the person who may read it', async () => {
    const aliceRead = await read(restored.base, seeded.alice.token, ['notes']);
    const note = aliceRead.notes.find((n: any) => n.id === seeded.comment);
    expect(note).toMatchObject({ content: 'Receipt attached', item_id: seeded.buyMilk });

    const owned = await fetch(`${restored.base}/api/v1/files/${seeded.fileId}`, { headers: { authorization: `Bearer ${seeded.alice.token}` } });
    expect(owned.status).toBe(200);
    expect(sha256(Buffer.from(await owned.arrayBuffer()))).toBe(sha256(RECEIPT));

    const other = await fetch(`${restored.base}/api/v1/files/${seeded.fileId}`, { headers: { authorization: `Bearer ${seeded.bob.token}` } });
    expect(other.ok).toBe(false);
    const anonymous = await fetch(`${restored.base}/api/v1/files/${seeded.fileId}`);
    expect(anonymous.status).toBe(401);
  });

  it('keeps each person’s data to themselves after the restore', async () => {
    const aliceRead = await read(restored.base, seeded.alice.token, ['items', 'projects']);
    const bobRead = await read(restored.base, seeded.bob.token, ['items', 'projects']);
    const carolRead = await read(restored.base, seeded.carol.token, ['items', 'projects']);

    const aliceProjects = aliceRead.projects.map((project: any) => project.name);
    const bobProjects = bobRead.projects.map((project: any) => project.name);
    expect(aliceProjects).toContain('Home');
    expect(aliceProjects).not.toContain('Work');
    expect(bobProjects).toContain('Work');
    expect(bobProjects).not.toContain('Home');

    expect(JSON.stringify(bobRead.items)).not.toContain('Buy milk');
    expect(JSON.stringify(bobRead.items)).toContain('Draft report');
    expect(JSON.stringify(aliceRead.items)).not.toContain('Draft report');
    expect(carolRead.items).toEqual([]);

    const bobFile = await fetch(`${restored.base}/api/v1/files/${seeded.fileId}`, { headers: { authorization: `Bearer ${seeded.bob.token}` } });
    expect(bobFile.ok).toBe(false);
  });

  it('keeps working after the restore: reads, writes, uploads and comments', async () => {
    const added = await createThrough(restored.base, seeded.alice.token, 'item_add', { content: 'After the restore', project_id: seeded.home });
    expect((await read(restored.base, seeded.alice.token, ['items'])).items.map((item: any) => item.id)).toContain(added);

    const bobTask = await createThrough(restored.base, seeded.bob.token, 'item_add', { content: 'Bob after the restore', project_id: seeded.work });
    expect((await read(restored.base, seeded.bob.token, ['items'])).items.map((item: any) => item.id)).toContain(bobTask);

    const fresh = await upload(restored.base, seeded.alice.token, 'second.txt', Buffer.from('second file'));
    const note = await createThrough(restored.base, seeded.alice.token, 'note_add', { item_id: seeded.buyMilk, content: 'Second file', file_attachment: fresh });
    expect(note).toBeTruthy();
  });

  it('lets the official MCP server read and write the restored data', async () => {
    const assistant = await connectAssistant(restored.base, seeded.alice.token);
    try {
      const found = await call(assistant, 'find-tasks', { projectId: seeded.home });
      expect(found.isError, found.text).toBe(false);
      const ids = found.data.tasks.map((task: { id: string }) => task.id);
      expect(ids).toContain(seeded.buyMilk);
      expect(ids).toContain(seeded.acknowledged[0]);

      const added = await call(assistant, 'add-tasks', { tasks: [{ content: 'Via the assistant', projectId: seeded.home }] });
      expect(added.data.successCount, added.text).toBe(1);
    } finally {
      await assistant.close();
    }
  });
});
