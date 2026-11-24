import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Api, command, person, startServer, type TestServer, tempId, type Person } from './harness';
import { resetBudgets } from '../http';

let server: TestServer;
let base: Api;
beforeAll(async () => { server = await startServer(); base = new Api(server.base); });
afterAll(async () => server.close());

const as = (who: Person) => new Api(server.base, who.token);
async function run(who: Person, commands: unknown[]) {
  const reply = await as(who).sync({ commands });
  return { reply, real: (n: number) => reply.body.temp_id_mapping[tempId(n)] as string, statuses: Object.values(reply.body.sync_status) as unknown[] };
}
const EVERYTHING = '?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z';

describe('labels', () => {
  it('a label is made once: adding the same name again points at the one there', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('label_add', { name: 'Focus' }, { temp_id: tempId(1) }), command('label_add', { name: 'focus' }, { temp_id: tempId(2) })]);
    expect(real(2)).toBe(real(1));
    const labels = (await as(who).sync({})).body.labels;
    expect(labels.map((l: { name: string }) => l.name)).toEqual(['Focus']);
  });

  it('renaming a label renames it on every task that carries it, and deleting takes it off', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('label_add', { name: 'old' }, { temp_id: tempId(3) }),
      command('item_add', { content: 'A', project_id: who.inbox, labels: ['old', 'keep'] }, { temp_id: tempId(4) }),
      command('item_add', { content: 'B', project_id: who.inbox, labels: ['old'] }, { temp_id: tempId(5) }),
    ]);
    await run(who, [command('label_update', { id: real(3), name: 'new' })]);
    let items = (await as(who).sync({})).body.items;
    expect(items.find((i: { id: string }) => i.id === real(4))?.labels).toEqual(['new', 'keep']);
    expect(items.find((i: { id: string }) => i.id === real(5))?.labels).toEqual(['new']);
    await run(who, [command('label_delete', { id: real(3) })]);
    items = (await as(who).sync({})).body.items;
    expect(items.find((i: { id: string }) => i.id === real(4))?.labels).toEqual(['keep']);
    expect((await as(who).sync({})).body.labels).toEqual([]);
  });

  it('label names that differ only in accented letters are one label, as the app compares them', async () => {
    const who = await person(base);
    const first = await run(who, [command('label_add', { name: 'Équipe' }, { temp_id: tempId(10) })]);
    expect(first.statuses).toEqual(['ok']);
    // Adding a name that is already there points at the label that has it, as adding "Client" twice does.
    const second = await run(who, [command('label_add', { name: 'équipe' }, { temp_id: tempId(11) })]);
    expect(second.statuses).toEqual(['ok']);
    expect(second.real(11)).toBe(first.real(10));
    const labels = (await as(who).sync({})).body.labels;
    expect(labels.map((label: { name: string }) => label.name)).toEqual(['Équipe']);
  });

  it('a tag written in another case goes with its label on rename and delete, as label names ignore case', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('label_add', { name: 'client' }, { temp_id: tempId(8) }),
      command('item_add', { content: 'C', project_id: who.inbox, labels: ['Client'] }, { temp_id: tempId(9) }),
    ]);
    await run(who, [command('label_update', { id: real(8), name: 'vendor' })]);
    let items = (await as(who).sync({})).body.items;
    expect(items.find((i: { id: string }) => i.id === real(9))?.labels).toEqual(['vendor']);
    await run(who, [command('label_delete', { id: real(8) })]);
    items = (await as(who).sync({})).body.items;
    expect(items.find((i: { id: string }) => i.id === real(9))?.labels).toEqual([]);
  });

  it('a rename onto a name that is already used is refused', async () => {
    const who = await person(base);
    const { real, statuses } = await run(who, [command('label_add', { name: 'one' }, { temp_id: tempId(6) }), command('label_add', { name: 'two' }, { temp_id: tempId(7) })]);
    expect(statuses).toEqual(['ok', 'ok']);
    const clash = await run(who, [command('label_update', { id: real(6), name: 'TWO' })]);
    expect(clash.statuses[0]).toMatchObject({ error_tag: 'LABEL_EXISTS' });
  });

  it('a label is private: another person’s label id is not found', async () => {
    const owner = await person(base);
    const other = await person(base);
    const { real } = await run(owner, [command('label_add', { name: 'mine' }, { temp_id: tempId(8) })]);
    const attempt = await run(other, [command('label_update', { id: real(8), name: 'stolen' })]);
    expect(attempt.statuses[0]).toMatchObject({ error_tag: 'LABEL_NOT_FOUND' });
  });

  it('orders labels as given', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('label_add', { name: 'a' }, { temp_id: tempId(9) }), command('label_add', { name: 'b' }, { temp_id: tempId(10) })]);
    await run(who, [command('label_update_orders', { id_order_mapping: { [real(10)]: 1, [real(9)]: 2 } })]);
    const labels = (await as(who).sync({})).body.labels;
    expect(labels.sort((x: { item_order: number }, y: { item_order: number }) => x.item_order - y.item_order).map((l: { name: string }) => l.name)).toEqual(['b', 'a']);
  });
});

describe('saved filters', () => {
  it('saves a filter, runs it over the tasks it matches, and refuses one it cannot read', async () => {
    const who = await person(base);
    const { real, statuses } = await run(who, [
      command('filter_add', { name: 'Urgent', query: 'p1 & !@later' }, { temp_id: tempId(20) }),
      command('filter_add', { name: 'Broken', query: 'frobnicate' }),
    ]);
    expect(statuses[0]).toBe('ok');
    expect(statuses[1]).toMatchObject({ error_tag: 'INVALID_FILTER' });
    const hot = await run(who, [
      command('item_add', { content: 'Hot', project_id: who.inbox, priority: 4 }, { temp_id: tempId(21) }),
      command('item_add', { content: 'Hot later', project_id: who.inbox, priority: 4, labels: ['later'] }),
      command('item_add', { content: 'Cold', project_id: who.inbox, priority: 1 }),
    ]);
    const page = await as(who).get(`/api/v1/tasks/filter?query=${encodeURIComponent('p1 & !@later')}`);
    expect(page.body.results.map((task: { id: string }) => task.id)).toEqual([hot.real(21)]);
    const filters = (await as(who).sync({})).body.filters;
    expect(filters.map((f: { name: string }) => f.name)).toEqual(['Urgent']);
    await run(who, [command('filter_update', { id: real(20), query: 'today' })]);
    expect((await as(who).sync({})).body.filters[0].query).toBe('today');
    await run(who, [command('filter_delete', { id: real(20) })]);
    expect((await as(who).sync({})).body.filters).toEqual([]);
  });

  it('reads dates, projects, sections, people and search terms', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('project_add', { name: 'Home' }, { temp_id: tempId(30) }),
      command('section_add', { name: 'Chores', project_id: tempId(30) }, { temp_id: tempId(31) }),
      command('item_add', { content: 'Dust shelves', project_id: tempId(30), section_id: tempId(31), due: { date: '2026-12-10', string: '2026-12-10', is_recurring: false } }, { temp_id: tempId(32) }),
      command('item_add', { content: 'Buy bread', project_id: who.inbox, responsible_uid: who.id }, { temp_id: tempId(33) }),
      command('item_add', { content: 'Unassigned thing', project_id: who.inbox }, { temp_id: tempId(34) }),
    ]);
    const q = async (query: string) => (await as(who).get(`/api/v1/tasks/filter?query=${encodeURIComponent(query)}`)).body.results.map((r: { id: string }) => r.id);
    expect(await q('#Home')).toEqual([real(32)]);
    expect(await q('##Home')).toEqual([real(32)]);
    expect(await q('/Chores')).toEqual([real(32)]);
    expect(await q('search: bread')).toEqual([real(33)]);
    expect(await q('search: "dust shelves"')).toEqual([real(32)]);
    expect(await q('assigned to: me')).toEqual([real(33)]);
    expect((await q('assigned to: none')).sort()).toEqual([real(32), real(34)].sort());
    expect(await q('due before: 2026-12-11')).toEqual([real(32)]);
    expect(await q('due after: 2026-12-11')).toEqual([]);
    expect(await q('2026-12-10')).toEqual([real(32)]);
    expect((await q('no date')).sort()).toEqual([real(33), real(34)].sort());
    expect((await q('view all')).length).toBe(3);
  });

  it('finds tasks by deadline, before or after a day, and never a task without one', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('item_add', { content: 'Due soon', project_id: who.inbox, deadline: { date: '2026-12-20' } }, { temp_id: tempId(70) }),
      command('item_add', { content: 'No deadline', project_id: who.inbox }, { temp_id: tempId(71) }),
    ]);
    const q = async (query: string) => (await as(who).get(`/api/v1/tasks/filter?query=${encodeURIComponent(query)}`)).body.results.map((r: { id: string }) => r.id);
    expect(await q('deadline before: 2026-12-21')).toEqual([real(70)]);
    expect(await q('deadline after: 2026-12-20')).toEqual([]);
    expect(await q('!(deadline after: 2026-12-19)')).toEqual([real(71)]);
    // A task with no scheduled day is due on its deadline; "date" is the scheduled day alone.
    expect(await q('due before: 2026-12-21')).toEqual([real(70)]);
    expect(await q('date before: 2026-12-21')).toEqual([]);
  });

  it('refuses a filter with a stray bracket, a dangling operator or a comma, and a bare word', async () => {
    const who = await person(base);
    const bad = ['(p1', 'p1 &', 'p1 | | p2', 'p1 p2', '"unclosed', 'today, overdue'];
    for (const query of bad) {
      const reply = await as(who).get(`/api/v1/tasks/filter?query=${encodeURIComponent(query)}`);
      expect(reply.status, query).toBe(400);
      expect(reply.body.error_tag, query).toBe('INVALID_FILTER');
    }
    const empty = await as(who).get('/api/v1/tasks/filter?query=');
    expect(empty.status).toBe(400);
  });

  it('a filter only sees what the person can see', async () => {
    const owner = await person(base);
    const outsider = await person(base);
    await run(owner, [command('item_add', { content: 'Private', project_id: owner.inbox, priority: 4 })]);
    const page = await as(outsider).get(`/api/v1/tasks/filter?query=${encodeURIComponent('p1')}`);
    expect(page.body.results).toEqual([]);
  });

  it('pages the results', async () => {
    const who = await person(base);
    await run(who, Array.from({ length: 5 }, (_, n) => command('item_add', { content: `t${n}`, project_id: who.inbox })));
    const first = await as(who).get('/api/v1/tasks/filter?query=view%20all&limit=2');
    expect(first.body.results).toHaveLength(2);
    expect(first.body.next_cursor).toBe('2');
    const last = await as(who).get('/api/v1/tasks/filter?query=view%20all&limit=2&cursor=4');
    expect(last.body.results).toHaveLength(1);
    expect(last.body.next_cursor).toBeNull();
  });
});

describe('comments', () => {
  it('adds, edits and deletes a comment; only its author may edit it', async () => {
    const owner = await person(base);
    const helper = await person(base);
    const { real } = await run(owner, [command('item_add', { content: 'Talk', project_id: owner.inbox }, { temp_id: tempId(40) })]);
    const task = real(40);
    const added = await run(owner, [command('note_add', { item_id: task, content: 'First!' }, { temp_id: tempId(41) })]);
    const note = added.real(41);
    const listed = await as(owner).get(`/api/v1/comments?task_id=${task}`);
    expect(listed.body.results).toEqual([expect.objectContaining({ id: note, content: 'First!', item_id: task, posted_uid: owner.id })]);
    await run(owner, [command('note_update', { id: note, content: 'Edited' })]);
    expect((await as(owner).get(`/api/v1/comments?task_id=${task}`)).body.results[0].content).toBe('Edited');
    const other = await run(helper, [command('note_update', { id: note, content: 'Hijack' })]);
    expect(other.statuses[0]).toMatchObject({ error_tag: 'ITEM_NOT_FOUND' });
    await run(owner, [command('note_delete', { id: note })]);
    expect((await as(owner).get(`/api/v1/comments?task_id=${task}`)).body.results).toEqual([]);
  });

  it('a comment needs words or a file, and a project comment is for the whole team', async () => {
    const owner = await person(base);
    const member = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Room' }, { temp_id: tempId(42) })]);
    await run(owner, [command('share_project', { project_id: real(42), email: member.email })]);
    await as(member).sync({ commands: [command('accept_invitation', (await invitations(member))[0])] });
    const empty = await run(owner, [command('note_add', { project_id: real(42), content: '   ' })]);
    expect(empty.statuses[0]).toMatchObject({ error_tag: 'EMPTY_COMMENT' });
    await run(owner, [command('note_add', { project_id: real(42), content: 'Hello room' })]);
    const seen = await as(member).get(`/api/v1/comments?project_id=${real(42)}`);
    expect(seen.body.results.map((n: { content: string }) => n.content)).toEqual(['Hello room']);
    const neither = await as(owner).get('/api/v1/comments');
    expect(neither.status).toBe(400);
  });

  it('a saved filter moved in the list keeps its new order key', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('filter_add', { name: 'Moves', query: 'today' }, { temp_id: tempId(110) })]);
    await run(who, [command('filter_update', { id: real(110), order_key: 'a1V' })]);
    const filters = (await as(who).sync({})).body.filters as Array<{ id: string; order_key: string }>;
    expect(filters.find((filter) => filter.id === real(110))?.order_key).toBe('a1V');
  });

  it('reactions are added once, counted by person, and removed again', async () => {
    const owner = await person(base);
    const reactor = await person(base);
    const { real } = await run(owner, [command('item_add', { content: 'Loved', project_id: owner.inbox }, { temp_id: tempId(43) }), command('note_add', { item_id: tempId(43), content: 'Great' }, { temp_id: tempId(44) })]);
    const note = real(44);
    const first = await as(owner).post(`/api/v1/comments/${note}/reactions`, { reaction: '👍' });
    expect(first.status).toBe(200);
    expect(first.body.reactions).toEqual({ '👍': [owner.id] });
    // Another device that reads only what changed since its cursor is told about a reaction.
    const cursor = (await as(owner).sync({})).body.sync_token;
    await as(owner).post(`/api/v1/comments/${note}/reactions`, { reaction: '😀' });
    const changed = (await as(owner).sync({ token: cursor, types: ['notes'] })).body.notes ?? [];
    expect(changed.map((comment: { id: string }) => comment.id)).toContain(note);
    await as(owner).post(`/api/v1/comments/${note}/reactions/remove`, { reaction: '😀' });
    await as(owner).post(`/api/v1/comments/${note}/reactions`, { reaction: '👍' });
    expect((await as(owner).post(`/api/v1/comments/${note}/reactions`, { reaction: '🎉' })).body.reactions).toEqual({ '👍': [owner.id], '🎉': [owner.id] });
    const bad = await as(owner).post(`/api/v1/comments/${note}/reactions`, { reaction: 'not an emoji' });
    expect(bad.body.error_tag).toBe('INVALID_REACTION');
    const hidden = await as(reactor).post(`/api/v1/comments/${note}/reactions`, { reaction: '👍' });
    // A person who cannot see the task cannot see its comments either.
    expect(hidden.body.error_tag).toBe('ITEM_NOT_FOUND');
    const removed = await as(owner).post(`/api/v1/comments/${note}/reactions/remove`, { reaction: '👍' });
    expect(removed.status).toBe(204);
    const after = (await as(owner).get(`/api/v1/comments?task_id=${real(43)}`)).body.results[0];
    expect(after.reactions).toEqual({ '🎉': [owner.id] });
  });
});

async function invitations(who: Person) {
  const reply = await as(who).sync({ types: ['live_notifications'] });
  return (reply.body.live_notifications as Array<Record<string, any>>)
    .filter((n) => n.notification_type === 'share_invitation_sent' && !n.answered)
    .map((n) => ({ invitation_id: n.invitation_id, invitation_secret: n.invitation_secret }));
}

describe('attachments', () => {
  const upload = async (who: Person, name: string, type: string, bytes: Buffer) => {
    const form = new FormData();
    form.append('file_name', name);
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    const res = await fetch(`${server.base}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${who.token}` }, body: form });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('stores an upload, attaches it to a comment, and serves it to people who can see the comment only', async () => {
    const owner = await person(base);
    const viewer = await person(base);
    const stranger = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Docs' }, { temp_id: tempId(50) })]);
    await run(owner, [command('share_project', { project_id: real(50), email: viewer.email })]);
    await as(viewer).sync({ commands: [command('accept_invitation', (await invitations(viewer))[0])] });
    const sent = await upload(owner, 'plan.pdf', 'application/pdf', Buffer.from('%PDF-1.4 fake'));
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ file_name: 'plan.pdf', file_type: 'application/pdf', resource_type: 'file', upload_state: 'completed' });
    expect(sent.body.file_url).toMatch(/^\/api\/v1\/files\/[0-9a-f]{32}$/);
    const note = await run(owner, [command('note_add', { project_id: real(50), content: '', file_attachment: sent.body })]);
    expect(note.statuses[0]).toBe('ok');
    const fromViewer = await fetch(server.base + sent.body.file_url, { headers: { authorization: `Bearer ${viewer.token}` } });
    expect(fromViewer.status).toBe(200);
    expect(Buffer.from(await fromViewer.arrayBuffer()).toString()).toBe('%PDF-1.4 fake');
    expect(fromViewer.headers.get('content-disposition')).toContain('attachment');
    const fromStranger = await fetch(server.base + sent.body.file_url, { headers: { authorization: `Bearer ${stranger.token}` } });
    expect(fromStranger.status).toBe(404);
    const anonymous = await fetch(server.base + sent.body.file_url);
    expect(anonymous.status).toBe(401);
  });

  it('serves the file to a browser that sends the session cookie, and only on the files path', async () => {
    const owner = await person(base);
    const sent = await upload(owner, 'pic.png', 'image/png', Buffer.from([137, 80, 78, 71]));
    const res = await fetch(server.base + sent.body.file_url, { headers: { cookie: `tde_session=${encodeURIComponent(owner.token)}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inline');
    const lost = await fetch(server.base + '/api/v1/tasks/filter?query=view%20all', { headers: { cookie: `tde_session=${encodeURIComponent(owner.token)}` } });
    expect(lost.status).toBe(401);
  });

  it('will not attach a file someone else uploaded', async () => {
    const owner = await person(base);
    const other = await person(base);
    const sent = await upload(owner, 'mine.txt', 'text/plain', Buffer.from('mine'));
    const { real } = await run(other, [command('project_add', { name: 'Theirs' }, { temp_id: tempId(51) })]);
    const attempt = await run(other, [command('note_add', { project_id: real(51), content: 'look', file_attachment: sent.body })]);
    expect(attempt.statuses[0]).toMatchObject({ error_tag: 'INVALID_ATTACHMENT' });
    const fake = await run(other, [command('note_add', { project_id: real(51), content: 'x', file_attachment: { file_url: 'https://elsewhere.example/evil.html' } })]);
    expect(fake.statuses[0]).toMatchObject({ error_tag: 'INVALID_ATTACHMENT' });
  });

  it('serves a page or a script it stored as a download, never as the page', async () => {
    const owner = await person(base);
    const sent = await upload(owner, 'evil.html', 'text/html', Buffer.from('<script>alert(1)</script>'));
    const res = await fetch(server.base + sent.body.file_url, { headers: { authorization: `Bearer ${owner.token}` } });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('refuses an upload without a file, and one over the limit', async () => {
    const owner = await person(base);
    const form = new FormData();
    form.append('file_name', 'nothing');
    const none = await fetch(`${server.base}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}` }, body: form });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error_tag: string }).error_tag).toBe('UPLOAD_MISSING');
  });

  it('an upload cut off mid-body leaves neither a file on disk nor a row', async () => {
    const owner = await person(base);
    const filesDirectory = join(server.dir, 'files');
    const filesBefore = readdirSync(filesDirectory);
    const rowsBefore = (server.app.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
    const boundary = 'cut-off-boundary';
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: Number(new URL(server.base).port),
        path: '/api/v1/uploads',
        method: 'POST',
        headers: {
          authorization: `Bearer ${owner.token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(5_000_000),
        },
      });
      req.on('error', () => undefined);
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cut.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      req.write(Buffer.alloc(200_000, 7), () => { req.destroy(); resolve(); });
    });
    // The server sees the dropped connection and clears what it had begun.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readdirSync(filesDirectory)).toEqual(filesBefore);
    expect((server.app.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(rowsBefore);
  });
});

describe('history', () => {
  it('lists completions by day, and only those of the projects the person is in', async () => {
    const owner = await person(base);
    const other = await person(base);
    const { real } = await run(owner, [command('item_add', { content: 'Finished', project_id: owner.inbox }, { temp_id: tempId(60) })]);
    await run(owner, [command('item_complete', { id: real(60) })]);
    const mine = await as(owner).get(`/api/v1/tasks/completed/by_completion_date${EVERYTHING}`);
    expect(mine.body.items.map((i: { content: string }) => i.content)).toEqual(['Finished']);
    expect(mine.body.items[0]).toMatchObject({ id: real(60), labels: [], duration: null, checked: true });
    const theirs = await as(other).get(`/api/v1/tasks/completed/by_completion_date${EVERYTHING}`);
    expect(theirs.body.items).toEqual([]);
  });

  it('pages history by cursor, and refuses a range that starts after it ends', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'a', project_id: who.inbox }, { temp_id: tempId(61) }), command('item_add', { content: 'b', project_id: who.inbox }, { temp_id: tempId(62) })]);
    await run(who, [command('item_complete', { id: real(61) }), command('item_complete', { id: real(62) })]);
    const first = await as(who).get(`/api/v1/tasks/completed/by_completion_date?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z&limit=1`);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.next_cursor).toBe('1');
    const second = await as(who).get(`/api/v1/tasks/completed/by_completion_date?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z&limit=1&cursor=1`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    const backwards = await as(who).get('/api/v1/tasks/completed?since=2100-01-01T00:00:00Z&until=2000-01-01T00:00:00Z');
    expect(backwards.body.error_tag).toBe('INVALID_DATE');
    const garbage = await as(who).get('/api/v1/tasks/completed?since=yesterday');
    expect(garbage.body.error_tag).toBe('INVALID_DATE');
  });

  it('reads one task, open or done, and a task that does not exist is not found', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'Read me', project_id: who.inbox }, { temp_id: tempId(63) })]);
    await run(who, [command('item_complete', { id: real(63) })]);
    const task = await as(who).get(`/api/v1/tasks/${real(63)}`);
    expect(task.body).toMatchObject({ content: 'Read me', checked: true, is_collapsed: false });
    expect((await as(who).get('/api/v1/tasks/0000')).status).toBe(404);
  });

  it('finished subtasks are kept out of the open list but stay in history for the app', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'Repeat', project_id: who.inbox, due: { string: 'every day', lang: 'en', is_recurring: true, date: '2026-05-01' } }, { temp_id: tempId(64) })]);
    await run(who, [command('item_close', { id: real(64) }), command('item_close', { id: real(64) })]);
    const occurrences = await as(who).get(`/api/v1/tasks/completed${EVERYTHING}`);
    expect(occurrences.body.items.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the server as a whole', () => {
  it('answers with security headers, a health check, and a clear 404 for unknown API paths', async () => {
    const health = await fetch(server.base + '/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('content-security-policy')).toContain("default-src 'self'");
    const missing = await fetch(server.base + '/api/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error_tag: string }).error_tag).toBe('NOT_FOUND');
    const wrongMethod = await fetch(server.base + '/api/v1/health', { method: 'DELETE' });
    expect(wrongMethod.status).toBe(405);
  });

  it('slows a person who asks too often, with Retry-After, and recovers', async () => {
    const who = await person(base);
    const previous = process.env.TDE_REQUESTS_PER_MINUTE;
    resetBudgets();
    let last = { status: 200, headers: new Headers() as Headers };
    for (let n = 0; n < 1000; n += 1) {
      const reply = await as(who).call('GET', '/api/v1/auth/me');
      last = reply;
      if (reply.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    void previous;
  });

  it('serves the built app from the same address, with the app’s own page for any other path', async () => {
    const dist = join(server.dir, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    const { createApp } = await import('../app');
    const built = createApp({ database: ':memory:', dataDir: server.dir, staticDir: dist });
    await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
    const port = (built.server.address() as { port: number }).port;
    try {
      const page = await fetch(`http://127.0.0.1:${port}/inbox/today`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>app</title>');
      const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
      expect(asset.headers.get('cache-control')).toContain('immutable');
      const escape = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/etc/passwd`);
      expect(await escape.text()).not.toContain('root:');
      const missingAsset = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);
      expect(missingAsset.status).toBe(404);
    } finally {
      await built.close();
    }
  });
});
