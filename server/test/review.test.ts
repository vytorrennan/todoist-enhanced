import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, command, person, startServer, type Person, type TestServer, tempId } from './harness';

/** Regressions for the findings of the council review: each one fails without its fix. */

let server: TestServer;
let base: Api;
beforeAll(async () => { server = await startServer(); base = new Api(server.base); });
afterAll(async () => server.close());

const as = (who: Person) => new Api(server.base, who.token);

async function invitesFor(who: Person) {
  const reply = await as(who).sync({ types: ['live_notifications'] });
  return (reply.body.live_notifications as Array<Record<string, any>>)
    .filter((n) => (n.notification_type === 'share_invitation_sent' || n.notification_type === 'workspace_invitation_created') && !n.answered);
}

async function acceptFirst(who: Person) {
  const [invite] = await invitesFor(who);
  return as(who).sync({ commands: [command('accept_invitation', { invitation_id: invite.invitation_id, invitation_secret: invite.invitation_secret })] });
}

async function run(who: Person, commands: unknown[]) {
  const reply = await as(who).sync({ commands });
  return { body: reply.body, real: (n: number) => reply.body.temp_id_mapping[tempId(n)] as string, statuses: Object.values(reply.body.sync_status) as unknown[] };
}

describe('the Inbox and the shared tree', () => {
  it('the Inbox never moves under a project, even by its owner', async () => {
    const owner = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Shelf' }, { temp_id: tempId(1) })]);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const moved = await run(owner, [command('project_update', { id: inbox, parent_id: real(1) })]);
    expect(moved.statuses[0]).toMatchObject({ error_tag: 'INBOX' });
    const projects = (await as(owner).get('/api/v1/projects')).body.results as Array<{ id: string; parent_id: string | null }>;
    expect(projects.find((project) => project.id === inbox)?.parent_id ?? null).toBeNull();
  });

  it('a folder does not detach a subproject from its parent unless the owner makes the change', async () => {
    const owner = await person(base);
    const admin = await person(base);
    const made = await run(owner, [
      command('workspace_add', { name: 'Hall' }, { temp_id: tempId(2) }),
      command('project_add', { name: 'Parent' }, { temp_id: tempId(3) }),
    ]);
    const hall = made.real(2);
    const parent = made.real(3);
    await run(owner, [command('workspace_invite', { workspace_id: hall, email: admin.email, role: 'ADMIN' })]);
    await acceptFirst(admin);
    const child = await run(owner, [command('project_add', { name: 'Child', parent_id: parent }, { temp_id: tempId(4) })]);
    const folder = await run(owner, [command('folder_add', { name: 'Clients', workspace_id: hall }, { temp_id: tempId(5) })]);
    await run(owner, [command('share_project', { project_id: child.real(4), email: admin.email, role: 'ADMIN' })]);
    await acceptFirst(admin);
    const moved = await run(admin, [command('project_update', { id: child.real(4), folder_id: folder.real(5) })]);
    expect(moved.statuses[0]).toMatchObject({ error_tag: 'PROJECT_ROLE_TOO_LOW' });
  });
});

describe('input that must be refused cleanly', () => {
  it('a due with anything after its time is refused, not stored', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const bad = await run(owner, [command('item_add', { content: 'Bad', project_id: inbox, due: { date: '2026-01-01T09:00garbage' } })]);
    expect(bad.statuses[0]).toMatchObject({ error_tag: 'INVALID_DATE' });
    const badMinutes = await run(owner, [command('item_add', { content: 'Bad', project_id: inbox, due: { date: '2026-01-01T09:99' } })]);
    expect(badMinutes.statuses[0]).toMatchObject({ error_tag: 'INVALID_DATE' });
  });

  it('a multipart upload without its boundary is a 400, not a server error', async () => {
    const owner = await person(base);
    const reply = await fetch(`${server.base}/api/v1/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'multipart/form-data' },
      body: 'no boundary here',
    });
    expect(reply.status).toBe(400);
  });

  it('a password longer than any account can hold is refused without being checked', async () => {
    const owner = await person(base);
    const reply = await fetch(`${server.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.email, password: 'x'.repeat(600) }),
    });
    expect(reply.status).toBe(401);
  });

  it('a non-numeric activity cursor is refused rather than answered with an empty page', async () => {
    const owner = await person(base);
    const reply = await as(owner).get('/api/v1/activities?cursor=abc');
    expect(reply.status).toBe(400);
  });
});

describe('what a person can see', () => {
  it('a folder in a workspace the person is not in is not found', async () => {
    const owner = await person(base);
    const stranger = await person(base);
    const made = await run(owner, [
      command('workspace_add', { name: 'Private hall' }, { temp_id: tempId(6) }),
      command('folder_add', { name: 'Secret', workspace_id: tempId(6) }, { temp_id: tempId(7) }),
    ]);
    const folder = made.real(7);
    expect((await as(owner).get(`/api/v1/folders/${folder}`)).status).toBe(200);
    expect((await as(stranger).get(`/api/v1/folders/${folder}`)).status).toBe(404);
  });

  it('productivity names only the projects the person is in', async () => {
    const owner = await person(base);
    const stranger = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Private colours' }, { temp_id: tempId(8) })]);
    const stats = (await as(stranger).get('/api/v1/tasks/completed/stats')).body as { project_colors: Record<string, string> };
    expect(Object.keys(stats.project_colors)).not.toContain(real(8));
  });

  it('a comment list goes a page at a time, and says where the next page starts', async () => {
    const who = await person(base);
    const inbox = (await as(who).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(who, [
      command('item_add', { content: 'Talk', project_id: inbox }, { temp_id: tempId(9) }),
      command('note_add', { item_id: tempId(9), content: 'one' }, { temp_id: tempId(10) }),
      command('note_add', { item_id: tempId(9), content: 'two' }, { temp_id: tempId(11) }),
      command('note_add', { item_id: tempId(9), content: 'three' }, { temp_id: tempId(12) }),
    ]);
    const task = real(9);
    const first = (await as(who).get(`/api/v1/comments?task_id=${task}&limit=2`)).body as { results: unknown[]; next_cursor: string | null };
    expect(first.results).toHaveLength(2);
    expect(first.next_cursor).toBe('2');
    const second = (await as(who).get(`/api/v1/comments?task_id=${task}&limit=2&cursor=${first.next_cursor}`)).body as { results: unknown[]; next_cursor: string | null };
    expect(second.results).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });

  it('a reminder names a member of the project, and only its setter and that member see it', async () => {
    const owner = await person(base);
    const stranger = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(owner, [command('item_add', { content: 'Ping', project_id: inbox }, { temp_id: tempId(13) })]);
    const task = real(13);
    const outsider = await as(owner).post('/api/v1/reminders', { task_id: task, minute_offset: 10, notify_uid: stranger.id });
    expect(outsider.status).toBe(400);
    expect(outsider.body.error_tag).toBe('NOT_A_MEMBER');
    const mine = await as(owner).post('/api/v1/reminders', { task_id: task, minute_offset: 10 });
    expect(mine.status).toBe(200);
    const listed = (await as(stranger).get('/api/v1/reminders')).body.results as unknown[];
    expect(listed).toHaveLength(0);
  });
});

/** The third review: each test fails without the fix it names. */
describe('the third review', () => {
  const share = (project: string, who: Person, role = 'READ_WRITE') =>
    command('share_project', { project_id: project, email: who.email, role });

  it('sync returns the reminders a person can see, and a deleted one as a tombstone', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(owner, [command('item_add', { content: 'Sync me', project_id: inbox }, { temp_id: tempId(30) })]);
    const made = await as(owner).post('/api/v1/reminders', { task_id: real(30), minute_offset: 10 });
    const first = await as(owner).sync({ types: ['reminders'] });
    expect((first.body.reminders as Array<{ id: string }>).map((r) => r.id)).toContain(made.body.id);
    await run(owner, [command('reminder_delete', { id: made.body.id })]);
    const next = await as(owner).sync({ types: ['reminders'], token: first.body.sync_token as string });
    expect(next.body.reminders).toContainEqual(expect.objectContaining({ id: made.body.id, is_deleted: true }));
  });

  it('a reminder given to someone else leaves the first person’s store at their next read', async () => {
    const owner = await person(base);
    const first = await person(base);
    const second = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Hand-offs' }, { temp_id: tempId(31) }),
      command('item_add', { content: 'Hand off', project_id: tempId(31) }, { temp_id: tempId(32) }),
    ]);
    await run(owner, [share(made.real(31), first), share(made.real(31), second)]);
    await acceptFirst(first);
    await acceptFirst(second);
    const set = await as(owner).post('/api/v1/reminders', { task_id: made.real(32), minute_offset: 10, notify_uid: first.id });
    expect(set.status).toBe(200);
    const before = await as(first).sync({ types: ['reminders'] });
    expect((before.body.reminders as Array<{ id: string }>).map((r) => r.id)).toContain(set.body.id);
    const moved = await as(owner).post(`/api/v1/reminders/${set.body.id as string}`, { notify_uid: second.id });
    expect(moved.status).toBe(200);
    const after = await as(first).sync({ types: ['reminders'], token: before.body.sync_token as string });
    expect(after.body.full_sync).toBe(true);
    expect((after.body.reminders as Array<{ id: string }>).map((r) => r.id)).not.toContain(set.body.id);
  });

  it('a reminder shows in the activity to the person who set it, not to the rest of the project', async () => {
    const owner = await person(base);
    const recipient = await person(base);
    const other = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Reminder activity' }, { temp_id: tempId(33) }),
      command('item_add', { content: 'Remind me', project_id: tempId(33) }, { temp_id: tempId(34) }),
    ]);
    await run(owner, [share(made.real(33), recipient), share(made.real(33), other)]);
    await acceptFirst(recipient);
    await acceptFirst(other);
    const set = await as(owner).post('/api/v1/reminders', { task_id: made.real(34), minute_offset: 10, notify_uid: recipient.id });
    expect(set.status).toBe(200);
    const byOwner = (await as(owner).get('/api/v1/activities?limit=50')).body.results as Array<{ object_type: string }>;
    expect(byOwner.some((event) => event.object_type === 'reminder')).toBe(true);
    const byOther = (await as(other).get('/api/v1/activities?limit=50')).body.results as Array<{ object_type: string }>;
    expect(byOther.some((event) => event.object_type === 'reminder')).toBe(false);
  });

  it('a reminder due with anything after its date is refused', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(owner, [command('item_add', { content: 'Due', project_id: inbox }, { temp_id: tempId(35) })]);
    const bad = await run(owner, [command('reminder_add', { item_id: real(35), type: 'absolute', due: { date: '2026-01-01junk' } }, { temp_id: tempId(36) })]);
    expect(bad.statuses[0]).toMatchObject({ error_tag: 'INVALID_DATE' });
  });

  it('joining a project does not name a folder the person cannot see', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const made = await run(owner, [
      command('workspace_add', { name: 'Folder hall' }, { temp_id: tempId(40) }),
      command('folder_add', { name: 'Hidden', workspace_id: tempId(40) }, { temp_id: tempId(41) }),
      command('project_add', { name: 'Shared hall' }, { temp_id: tempId(42) }),
      command('project_move_to_workspace', { project_id: tempId(42), workspace_id: tempId(40) }),
      command('project_update', { id: tempId(42), folder_id: tempId(41) }),
    ]);
    await run(owner, [share(made.real(42), guest)]);
    const joined = await as(guest).post(`/api/v1/projects/${made.real(42)}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.folder).toBeNull();
  });

  it('a subtask is in its parent’s section, whatever section it names', async () => {
    const owner = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Sections' }, { temp_id: tempId(50) }),
      command('section_add', { name: 'First', project_id: tempId(50) }, { temp_id: tempId(51) }),
      command('section_add', { name: 'Second', project_id: tempId(50) }, { temp_id: tempId(52) }),
      command('item_add', { content: 'Parent', project_id: tempId(50), section_id: tempId(51) }, { temp_id: tempId(53) }),
      command('item_add', { content: 'Child', parent_id: tempId(53), section_id: tempId(52) }, { temp_id: tempId(54) }),
    ]);
    expect(made.statuses.filter((status) => (status as { error_code?: number }).error_code !== undefined)).toEqual([]);
    const items = (await as(owner).sync({ types: ['items'] })).body.items as Array<{ content: string; section_id: string | null }>;
    expect(items.find((item) => item.content === 'Parent')?.section_id).toBe(made.real(51));
    expect(items.find((item) => item.content === 'Child')?.section_id).toBe(made.real(51));
  });

  it('a project admin cannot move a project into a workspace', async () => {
    const owner = await person(base);
    const admin = await person(base);
    const made = await run(owner, [
      command('workspace_add', { name: 'Target hall' }, { temp_id: tempId(60) }),
      command('project_add', { name: 'Owned by one' }, { temp_id: tempId(61) }),
    ]);
    const hall = made.real(60);
    const project = made.real(61);
    await run(owner, [command('workspace_invite', { workspace_id: hall, email: admin.email, role: 'ADMIN' })]);
    await acceptFirst(admin);
    await run(owner, [share(project, admin, 'ADMIN')]);
    await acceptFirst(admin);
    const moved = await run(admin, [command('project_move_to_workspace', { project_id: project, workspace_id: hall })]);
    expect(moved.statuses[0]).toMatchObject({ error_tag: 'PROJECT_ROLE_TOO_LOW' });
    expect((await as(admin).get(`/api/v1/projects/${project}`)).body.workspace_id ?? null).toBeNull();
  });

  it('a null color or section order keeps the one there is', async () => {
    const owner = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Keep colour' }, { temp_id: tempId(70) }),
      command('section_add', { name: 'Keep order', project_id: tempId(70) }, { temp_id: tempId(71) }),
    ]);
    const project = made.real(70);
    const section = made.real(71);
    const color = (await as(owner).get(`/api/v1/projects/${project}`)).body.color;
    const orderOf = async () => ((await as(owner).sync({ types: ['sections'] })).body.sections as Array<{ id: string; section_order: number }>)
      .find((row) => row.id === section)?.section_order;
    const order = await orderOf();
    const nulled = await run(owner, [
      command('project_update', { id: project, color: null }),
      command('section_update', { id: section, section_order: null }),
    ]);
    expect(nulled.statuses).not.toContainEqual(expect.objectContaining({ error_code: 500 }));
    expect((await as(owner).get(`/api/v1/projects/${project}`)).body.color).toBe(color);
    expect(await orderOf()).toBe(order);
  });

  it('a CSV import reads a fractional indent as the whole one, and keeps the time of a due', async () => {
    const who = await person(base);
    const project = await as(who).post('/api/v1/projects', { name: 'Fractions' });
    const csv = 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\ntask,Parent,,1,1,,,,,\ntask,Child,,1,1.5,,,2026-03-01T09:30,,\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'plan.csv');
    const reply = await fetch(`${server.base}/api/v1/projects/${project.body.id as string}/import`, { method: 'POST', headers: { authorization: `Bearer ${who.token}` }, body: form });
    expect(reply.status).toBe(200);
    const body = (await reply.json()) as { tasks: Array<{ content: string; due: { string: string } | null }> };
    expect(body.tasks.map((task) => task.content)).toEqual(['Parent', 'Child']);
    expect(body.tasks.find((task) => task.content === 'Child')?.due?.string).toBe('2026-03-01T09:30');
  });

  it('a body or a command that is not an object is refused, not a server error', async () => {
    const owner = await person(base);
    const reply = await fetch(`${server.base}/api/v1/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: '"just a string"',
    });
    expect(reply.status).toBe(400);
    const sent = await as(owner).sync({ commands: [{ type: 'item_add', uuid: 'primitive-args', args: 5 }] });
    expect(Object.values(sent.body.sync_status)).toEqual([expect.objectContaining({ error_tag: 'INVALID_ARGUMENT' })]);
  });

  it('a shared label rename refuses a blank or over-long name', async () => {
    const owner = await person(base);
    const blank = await as(owner).post('/api/v1/labels/shared/rename', { name: 'work', new_name: '   ' });
    expect(blank.status).toBe(400);
    const long = await as(owner).post('/api/v1/labels/shared/rename', { name: 'work', new_name: 'x'.repeat(121) });
    expect(long.status).toBe(400);
  });
});

/** The fourth review: each test fails without the fix it names. */
describe('the fourth review', () => {
  const share = (project: string, who: Person, role = 'READ_WRITE') =>
    command('share_project', { project_id: project, email: who.email, role });

  it('the person who set a reminder sees the edits and removal the person it is for makes', async () => {
    const owner = await person(base);
    const recipient = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Edits seen' }, { temp_id: tempId(80) }),
      command('item_add', { content: 'Watched', project_id: tempId(80) }, { temp_id: tempId(81) }),
    ]);
    await run(owner, [share(made.real(80), recipient)]);
    await acceptFirst(recipient);
    const set = await as(owner).post('/api/v1/reminders', { task_id: made.real(81), minute_offset: 10, notify_uid: recipient.id });
    expect(set.status).toBe(200);
    const id = set.body.id as string;
    expect((await run(recipient, [command('reminder_update', { id, minute_offset: 20 })])).statuses).toEqual(['ok']);
    expect((await run(recipient, [command('reminder_delete', { id })])).statuses).toEqual(['ok']);
    const seen = (await as(owner).get('/api/v1/activities?limit=50')).body.results as Array<{ object_type: string; event_type: string }>;
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ object_type: 'reminder', event_type: 'updated' }),
      expect.objectContaining({ object_type: 'reminder', event_type: 'deleted' }),
    ]));
  });

  it('the person a reminder is for cannot hand it to someone else', async () => {
    const owner = await person(base);
    const recipient = await person(base);
    const third = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Hand-on refused' }, { temp_id: tempId(82) }),
      command('item_add', { content: 'Not yours to pass', project_id: tempId(82) }, { temp_id: tempId(83) }),
    ]);
    await run(owner, [share(made.real(82), recipient), share(made.real(82), third)]);
    await acceptFirst(recipient);
    await acceptFirst(third);
    const set = await as(owner).post('/api/v1/reminders', { task_id: made.real(83), minute_offset: 10, notify_uid: recipient.id });
    const passed = await run(recipient, [command('reminder_update', { id: set.body.id, notify_uid: third.id })]);
    expect(passed.statuses[0]).toMatchObject({ error_tag: 'NOT_THE_SETTER' });
    expect((await as(recipient).get(`/api/v1/reminders/${set.body.id as string}`)).status).toBe(200);
  });

  it('a reminder whose task is deleted is removed on the next incremental sync', async () => {
    const owner = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Gone task' }, { temp_id: tempId(90) }),
      command('item_add', { content: 'Doomed', project_id: tempId(90) }, { temp_id: tempId(91) }),
    ]);
    const set = await as(owner).post('/api/v1/reminders', { task_id: made.real(91), minute_offset: 10 });
    const first = await as(owner).sync({ types: ['reminders'] });
    expect((first.body.reminders as Array<{ id: string }>).map((r) => r.id)).toContain(set.body.id);
    await run(owner, [command('item_delete', { id: made.real(91) })]);
    const next = await as(owner).sync({ types: ['reminders'], token: first.body.sync_token as string });
    expect(next.body.reminders).toContainEqual(expect.objectContaining({ id: set.body.id, is_deleted: true }));
  });

  it('a reminder whose project is deleted is removed on the next incremental sync', async () => {
    const owner = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Gone project' }, { temp_id: tempId(92) }),
      command('item_add', { content: 'Inside', project_id: tempId(92) }, { temp_id: tempId(93) }),
    ]);
    const set = await as(owner).post('/api/v1/reminders', { task_id: made.real(93), minute_offset: 10 });
    const first = await as(owner).sync({ types: ['reminders'] });
    expect((first.body.reminders as Array<{ id: string }>).map((r) => r.id)).toContain(set.body.id);
    await run(owner, [command('project_delete', { id: made.real(92) })]);
    const next = await as(owner).sync({ types: ['reminders'], token: first.body.sync_token as string });
    expect(next.body.reminders).toContainEqual(expect.objectContaining({ id: set.body.id, is_deleted: true }));
  });

  it('renaming a label to one the task has in another case leaves one of them', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(owner, [command('item_add', { content: 'Tagged', project_id: inbox, labels: ['work', 'Urgent'] }, { temp_id: tempId(100) })]);
    const renamed = await as(owner).post('/api/v1/labels/shared/rename', { name: 'work', new_name: 'urgent' });
    expect(renamed.status).toBeLessThan(300);
    const items = (await as(owner).sync({ types: ['items'] })).body.items as Array<{ id: string; labels: string[] }>;
    expect(items.find((item) => item.id === real(100))?.labels).toEqual(['urgent']);
  });

  it('an order that is not a whole number, or a null entry, is refused rather than a server error', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(owner, [command('item_add', { content: 'Ordered', project_id: inbox }, { temp_id: tempId(110) })]);
    const badDay = await run(owner, [command('item_update_day_orders', { ids_to_orders: { [real(110)]: 'abc' } })]);
    expect(badDay.statuses[0]).toMatchObject({ error_tag: 'INVALID_ARGUMENT' });
    const badProject = await run(owner, [command('project_reorder', { projects: [null] })]);
    expect(badProject.statuses[0]).toMatchObject({ error_tag: 'INVALID_ARGUMENT' });
  });

  it('a project admin outside the workspace cannot file the project in one of its folders', async () => {
    const owner = await person(base);
    const admin = await person(base);
    const made = await run(owner, [
      command('workspace_add', { name: 'Filing hall' }, { temp_id: tempId(120) }),
      command('folder_add', { name: 'Filed', workspace_id: tempId(120) }, { temp_id: tempId(121) }),
      command('project_add', { name: 'To file' }, { temp_id: tempId(122) }),
      command('project_move_to_workspace', { project_id: tempId(122), workspace_id: tempId(120) }),
    ]);
    await run(owner, [share(made.real(122), admin, 'ADMIN')]);
    await acceptFirst(admin);
    const filed = await run(admin, [command('project_update', { id: made.real(122), folder_id: made.real(121) })]);
    expect(filed.statuses[0]).toMatchObject({ error_tag: 'FOLDER_NOT_IN_WORKSPACE' });
  });
});

/** The fifth review: each test fails without the fix it names. */
describe('the fifth review', () => {
  const share = (project: string, who: Person, role = 'READ_WRITE') =>
    command('share_project', { project_id: project, email: who.email, role });

  it('a malformed order key is refused, and the next task is still added among its siblings', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const bad = await run(owner, [command('item_add', { content: 'Malformed', project_id: inbox, order_key: 'not a key!' }, { temp_id: tempId(130) })]);
    expect(bad.statuses[0]).toMatchObject({ error_tag: 'INVALID_ORDER_KEY' });
    const next = await run(owner, [command('item_add', { content: 'Ordinary', project_id: inbox }, { temp_id: tempId(131) })]);
    expect(next.statuses).toEqual(['ok']);
    const badOrder = await run(owner, [command('project_reorder', { projects: [{ id: inbox, order_key: 'zz!' }] })]);
    expect(badOrder.statuses[0]).toMatchObject({ error_tag: 'INVALID_ORDER_KEY' });
  });

  it('a workspace guest cannot file a project in a folder', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const made = await run(owner, [
      command('workspace_add', { name: 'Guest hall' }, { temp_id: tempId(140) }),
      command('folder_add', { name: 'Team folder', workspace_id: tempId(140) }, { temp_id: tempId(141) }),
      command('project_add', { name: 'Guest project' }, { temp_id: tempId(142) }),
      command('project_move_to_workspace', { project_id: tempId(142), workspace_id: tempId(140) }),
    ]);
    await run(owner, [command('workspace_invite', { workspace_id: made.real(140), email: guest.email, role: 'GUEST' })]);
    await acceptFirst(guest);
    await run(owner, [share(made.real(142), guest, 'ADMIN')]);
    await acceptFirst(guest);
    const filed = await run(guest, [command('project_update', { id: made.real(142), folder_id: made.real(141) })]);
    expect(filed.statuses[0]).toMatchObject({ error_tag: 'FOLDER_NOT_IN_WORKSPACE' });
  });

  it('an order that is null, blank or true is refused, not stored as zero or one', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(owner, [command('item_add', { content: 'Numbered', project_id: inbox }, { temp_id: tempId(150) })]);
    const nulled = await run(owner, [command('item_update_day_orders', { ids_to_orders: { [real(150)]: null } })]);
    expect(nulled.statuses[0]).toMatchObject({ error_tag: 'INVALID_ARGUMENT' });
    const blank = await run(owner, [command('item_reorder', { items: [{ id: real(150), child_order: '' }] })]);
    expect(blank.statuses[0]).toMatchObject({ error_tag: 'INVALID_ARGUMENT' });
    const truth = await run(owner, [command('project_reorder', { projects: [{ id: inbox, child_order: true }] })]);
    expect(truth.statuses[0]).toMatchObject({ error_tag: 'INVALID_ARGUMENT' });
  });

  it('an item order with a null entry is refused rather than a server error', async () => {
    const owner = await person(base);
    const bad = await run(owner, [command('item_reorder', { items: [null] })]);
    expect(bad.statuses[0]).toMatchObject({ error_tag: 'INVALID_ARGUMENT' });
  });

  it('a person removed from a project is not sent the removal of a reminder in it', async () => {
    const owner = await person(base);
    const member = await person(base);
    const made = await run(owner, [
      command('project_add', { name: 'Left behind' }, { temp_id: tempId(160) }),
      command('item_add', { content: 'Left task', project_id: tempId(160) }, { temp_id: tempId(161) }),
    ]);
    await run(owner, [share(made.real(160), member)]);
    await acceptFirst(member);
    const set = await as(owner).post('/api/v1/reminders', { task_id: made.real(161), minute_offset: 10, notify_uid: member.id });
    expect(set.status).toBe(200);
    await run(owner, [command('delete_collaborator', { project_id: made.real(160), email: member.email })]);
    const afterRemoval = await as(member).sync({ types: ['reminders'] });
    await run(owner, [command('item_delete', { id: made.real(161) })]);
    const next = await as(member).sync({ types: ['reminders'], token: afterRemoval.body.sync_token as string });
    expect(next.body.reminders).not.toContainEqual(expect.objectContaining({ id: set.body.id }));
  });
});

describe('a CSV import', () => {
  it('keeps a subtask in its parent\'s section', async () => {
    const who = await person(base);
    const project = await as(who).post('/api/v1/projects', { name: 'CSV target' });
    const projectId = project.body.id as string;
    const csv = 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\nsection,Plan,,,,,,,,\ntask,Parent,,1,1,,,,,\ntask,Child,,1,2,,,,,\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'plan.csv');
    const reply = await fetch(`${server.base}/api/v1/projects/${projectId}/import`, { method: 'POST', headers: { authorization: `Bearer ${who.token}` }, body: form });
    expect(reply.status).toBe(200);
    const body = (await reply.json()) as { sections: Array<{ id: string }>; tasks: Array<{ content: string; section_id: string | null }> };
    const sectionId = body.sections[0].id;
    expect(body.tasks.find((task) => task.content === 'Child')?.section_id).toBe(sectionId);
  });
});

describe('the second review', () => {
  it('a reminder update without a minute count is refused, and a negative activity limit is not unbounded', async () => {
    const owner = await person(base);
    const inbox = (await as(owner).get('/api/v1/user')).body.inbox_project_id as string;
    const { real } = await run(owner, [command('item_add', { content: 'Nudge', project_id: inbox }, { temp_id: tempId(20) })]);
    const made = await as(owner).post('/api/v1/reminders', { task_id: real(20), minute_offset: 5 });
    const id = made.body.id as string;
    const bad = await as(owner).post(`/api/v1/reminders/${id}`, { minute_offset: null });
    expect(bad.status).toBe(400);
    const listed = await as(owner).get('/api/v1/activities?limit=-5');
    expect(listed.status).toBe(200);
    expect((listed.body.results as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('a CSV import sent without a multipart body is refused', async () => {
    const owner = await person(base);
    const project = await as(owner).post('/api/v1/projects', { name: 'Not a form' });
    const reply = await fetch(`${server.base}/api/v1/projects/${project.body.id as string}/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: '{"csv":"TYPE,CONTENT\\ntask,x"}',
    });
    expect(reply.status).toBe(400);
  });
});
