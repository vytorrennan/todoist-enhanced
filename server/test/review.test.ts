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
