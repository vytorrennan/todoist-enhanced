import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, command, person, startServer, type TestServer, tempId, type Person } from './harness';

let server: TestServer;
let base: Api;
beforeAll(async () => { server = await startServer(); base = new Api(server.base); });
afterAll(async () => server.close());

/** Runs commands for a person and returns the reply, with each temporary id resolved. */
async function run(who: Person, commands: unknown[]) {
  const reply = await new Api(server.base, who.token).sync({ commands });
  return { reply, real: (n: number) => reply.body.temp_id_mapping[tempId(n)] as string };
}

async function openTasks(who: Person) {
  const reply = await new Api(server.base, who.token).sync({});
  return reply.body.items as Array<Record<string, any>>;
}

describe('tasks: creating and editing', () => {
  it('creates a task with its date, priority, labels and duration, and reads them back', async () => {
    const who = await person(base);
    const { reply, real } = await run(who, [command('item_add', {
      content: 'Plan the week', project_id: who.inbox, priority: 4, labels: ['week', 'quick', 'week'],
      due: { date: '2026-12-01', string: '2026-12-01', lang: 'en', is_recurring: false },
      deadline: { date: '2026-12-05', lang: 'en' }, duration: { amount: 45, unit: 'minute' },
    }, { temp_id: tempId(1) })]);
    expect(reply.body.sync_status[Object.keys(reply.body.sync_status)[0]]).toBe('ok');
    const task = (await openTasks(who)).find((item) => item.id === real(1));
    expect(task).toMatchObject({
      content: 'Plan the week', priority: 4, labels: ['week', 'quick'], checked: false,
      due: { date: '2026-12-01', is_recurring: false }, deadline: { date: '2026-12-05' }, duration: { amount: 45, unit: 'minute' },
      responsible_uid: null, note_count: 0, collapsed: false,
    });
    expect(task?.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refuses an empty title, an unknown priority, a bad date, and a duration in weeks', async () => {
    const who = await person(base);
    const { reply } = await run(who, [
      command('item_add', { content: '   ', project_id: who.inbox }),
      command('item_add', { content: 'x', project_id: who.inbox, priority: 9 }),
      command('item_add', { content: 'x', project_id: who.inbox, due: { date: '2026-02-30', is_recurring: false } }),
      command('item_add', { content: 'x', project_id: who.inbox, duration: { amount: 2, unit: 'week' } }),
    ]);
    const errors = Object.values(reply.body.sync_status).map((s) => (s as { error_tag: string }).error_tag);
    expect(errors).toEqual(['INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_DATE', 'INVALID_DURATION']);
  });

  it('a task that is not dated is not given a day by accident', async () => {
    const who = await person(base);
    await run(who, [command('item_add', { content: 'No date', project_id: who.inbox })]);
    const [task] = await openTasks(who);
    expect(task.due).toBeNull();
  });

  it('updates fields and leaves the others alone; a null clears a date', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'Old', project_id: who.inbox, due: { date: '2026-12-02', string: '2026-12-02', is_recurring: false } }, { temp_id: tempId(2) })]);
    const id = real(2);
    await run(who, [command('item_update', { id, content: 'New', priority: 2 })]);
    let task = (await openTasks(who)).find((t) => t.id === id);
    expect(task).toMatchObject({ content: 'New', priority: 2, due: { date: '2026-12-02' } });
    await run(who, [command('item_update', { id, due: null })]);
    task = (await openTasks(who)).find((t) => t.id === id);
    expect(task?.due).toBeNull();
  });

  it('a task can be given to a member of the project, and not to a stranger or a read-only member', async () => {
    const owner = await person(base);
    const helper = await person(base);
    const reader = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Shared' }, { temp_id: tempId(3) })]);
    const project = real(3);
    await run(owner, [command('share_project', { project_id: project, email: helper.email, role: 'READ_WRITE' })]);
    await run(owner, [command('share_project', { project_id: project, email: reader.email, role: 'READ_ONLY' })]);
    await new Api(server.base, helper.token).sync({ commands: [command('live_notifications_mark_read_all', {})] });
    const accept = (await new Api(server.base, helper.token).sync({})).body.live_notifications.find((n: { notification_type: string }) => n.notification_type === 'share_invitation_sent');
    await new Api(server.base, helper.token).sync({ commands: [command('accept_invitation', { invitation_id: accept.invitation_id, invitation_secret: accept.invitation_secret })] });
    const readerNote = (await new Api(server.base, reader.token).sync({})).body.live_notifications.find((n: { notification_type: string }) => n.notification_type === 'share_invitation_sent');
    await new Api(server.base, reader.token).sync({ commands: [command('accept_invitation', { invitation_id: readerNote.invitation_id, invitation_secret: readerNote.invitation_secret })] });
    const { reply, real: task } = await run(owner, [command('item_add', { content: 'For Helper', project_id: project, responsible_uid: helper.id }, { temp_id: tempId(4) }), command('item_add', { content: 'For reader', project_id: project, responsible_uid: reader.id })]);
    const statuses = Object.values(reply.body.sync_status) as unknown[];
    expect(statuses[0]).toBe('ok');
    expect(statuses[1]).toMatchObject({ error_tag: 'ASSIGNEE_NOT_IN_PROJECT' });
    expect(task(4)).toBeDefined();
    const stranger = await person(base);
    const { reply: bad } = await run(owner, [command('item_update', { id: task(4), responsible_uid: stranger.id })]);
    expect(Object.values(bad.body.sync_status)[0]).toMatchObject({ error_tag: 'ASSIGNEE_NOT_IN_PROJECT' });
  });
});

describe('tasks: completing, closing and reopening', () => {
  it('completes a task, records it in history, and reopens it', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'Done soon', project_id: who.inbox }, { temp_id: tempId(10) })]);
    const id = real(10);
    await run(who, [command('item_complete', { id })]);
    const done = (await new Api(server.base, who.token).sync({ token: '0' })).body.items.find((i: { id: string }) => i.id === id);
    expect(done).toMatchObject({ checked: true });
    expect(done.completed_at).toBeTruthy();
    expect((await openTasks(who)).some((t) => t.id === id)).toBe(false);
    const history = await new Api(server.base, who.token).get(`/api/v1/tasks/completed/by_completion_date?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z`);
    expect(history.body.items.map((e: { id: string }) => e.id)).toEqual([id]);
    await run(who, [command('item_uncomplete', { id })]);
    expect((await openTasks(who)).some((t) => t.id === id)).toBe(true);
    const after = await new Api(server.base, who.token).get(`/api/v1/tasks/completed/by_completion_date?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z`);
    expect(after.body.items).toEqual([]);
  });

  it('completing a task completes its open subtasks too, and each one is in history', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('item_add', { content: 'Parent', project_id: who.inbox }, { temp_id: tempId(11) }),
      command('item_add', { content: 'Child', project_id: who.inbox, parent_id: tempId(11) }, { temp_id: tempId(12) }),
    ]);
    await run(who, [command('item_complete', { id: real(11) })]);
    const history = await new Api(server.base, who.token).get('/api/v1/tasks/completed/by_completion_date?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z');
    expect(history.body.items.map((e: { id: string }) => e.id).sort()).toEqual([real(11), real(12)].sort());
  });

  it('closing a repeating task moves it to its next day and keeps the occurrence in history', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'Water', project_id: who.inbox, due: { string: 'every day', lang: 'en', is_recurring: true, date: '2026-01-10' } }, { temp_id: tempId(13) })]);
    const id = real(13);
    await run(who, [command('item_close', { id })]);
    const [task] = (await openTasks(who)).filter((t) => t.id === id);
    expect(task.checked).toBe(false);
    expect(task.due.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(task.due.date > '2026-01-10').toBe(true);
    expect(task.due.is_recurring).toBe(true);
    const history = await new Api(server.base, who.token).get('/api/v1/tasks/completed/by_completion_date?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z');
    expect(history.body.items).toEqual([]);
    const occurrences = await new Api(server.base, who.token).get('/api/v1/tasks/completed?since=2000-01-01T00:00:00Z&until=2100-01-01T00:00:00Z');
    expect(occurrences.body.items).toEqual([expect.objectContaining({ task_id: id, item_object: expect.objectContaining({ due: { is_recurring: true } }) })]);
  });

  it('a repeating task whose rule has run out is simply finished', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'Last one', project_id: who.inbox, due: { string: 'every day until 2026-01-02', lang: 'en', is_recurring: true, date: '2026-01-01' } }, { temp_id: tempId(14) })]);
    await run(who, [command('item_close', { id: real(14) })]);
    const [task] = (await new Api(server.base, who.token).sync({ token: '0' })).body.items.filter((t: { id: string }) => t.id === real(14));
    expect(task.checked).toBe(true);
  });

  it('item_complete on a repeating task ends the series instead of moving it', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'End it', project_id: who.inbox, due: { string: 'every week', lang: 'en', is_recurring: true, date: '2026-01-05' } }, { temp_id: tempId(15) })]);
    await run(who, [command('item_complete', { id: real(15) })]);
    const reply = await new Api(server.base, who.token).sync({ token: '0' });
    const [task] = reply.body.items.filter((t: { id: string }) => t.id === real(15));
    expect(task.checked).toBe(true);
    expect(task.due.date).toBe('2026-01-05');
  });
});

describe('tasks: deleting, moving and ordering', () => {
  it('deleting a task deletes what is under it, and the deletion reaches the other devices', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('item_add', { content: 'Top', project_id: who.inbox }, { temp_id: tempId(20) }),
      command('item_add', { content: 'Middle', project_id: who.inbox, parent_id: tempId(20) }, { temp_id: tempId(21) }),
      command('item_add', { content: 'Bottom', project_id: who.inbox, parent_id: tempId(21) }, { temp_id: tempId(22) }),
    ]);
    await run(who, [command('item_delete', { id: real(20) })]);
    expect(await openTasks(who)).toEqual([]);
    const reply = await new Api(server.base, who.token).sync({ token: '0' });
    const deleted = reply.body.items.filter((i: { is_deleted: boolean }) => i.is_deleted).map((i: { id: string }) => i.id).sort();
    expect(deleted).toEqual([real(20), real(21), real(22)].sort());
  });

  it('moves a task to another project with its subtasks, and clears the assignee who is not there', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('project_add', { name: 'Elsewhere' }, { temp_id: tempId(30) }),
      command('item_add', { content: 'Parent', project_id: who.inbox }, { temp_id: tempId(31) }),
      command('item_add', { content: 'Kid', project_id: who.inbox, parent_id: tempId(31) }, { temp_id: tempId(32) }),
    ]);
    await run(who, [command('item_move', { id: real(31), project_id: real(30) })]);
    const items = await openTasks(who);
    expect(items.find((i) => i.id === real(31))?.project_id).toBe(real(30));
    expect(items.find((i) => i.id === real(32))?.project_id).toBe(real(30));
  });

  it('refuses to make a task its own ancestor', async () => {
    const who = await person(base);
    const { real, reply } = await run(who, [
      command('item_add', { content: 'A', project_id: who.inbox }, { temp_id: tempId(40) }),
      command('item_add', { content: 'B', project_id: who.inbox, parent_id: tempId(40) }, { temp_id: tempId(41) }),
    ]);
    expect(Object.keys(reply.body.sync_status).length).toBe(2);
    const cycle = await run(who, [command('item_move', { id: real(40), parent_id: real(41) })]);
    expect(Object.values(cycle.reply.body.sync_status)[0]).toMatchObject({ error_tag: 'CYCLE' });
    const self = await run(who, [command('item_move', { id: real(40), parent_id: real(40) })]);
    expect(Object.values(self.reply.body.sync_status)[0]).toMatchObject({ error_tag: 'CYCLE' });
  });

  it('reorders siblings, and the order the app reads is the one it asked for', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('item_add', { content: 'first', project_id: who.inbox }, { temp_id: tempId(50) }),
      command('item_add', { content: 'second', project_id: who.inbox }, { temp_id: tempId(51) }),
      command('item_add', { content: 'third', project_id: who.inbox }, { temp_id: tempId(52) }),
    ]);
    await run(who, [command('item_reorder', { items: [{ id: real(52), child_order: 1 }, { id: real(50), child_order: 2 }, { id: real(51), child_order: 3 }] })]);
    const order = (await openTasks(who)).sort((a, b) => (a.order_key < b.order_key ? -1 : 1)).map((i) => i.content);
    expect(order).toEqual(['third', 'first', 'second']);
  });

  it('keeps the day order the planner gave', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('item_add', { content: 'Day', project_id: who.inbox }, { temp_id: tempId(60) })]);
    await run(who, [command('item_update_day_orders', { ids_to_orders: { [real(60)]: 7 } })]);
    expect((await openTasks(who)).find((i) => i.id === real(60))?.day_order).toBe(7);
  });

  it('a task with a missing or foreign project is refused', async () => {
    const who = await person(base);
    const stranger = await person(base);
    const { real } = await run(stranger, [command('item_add', { content: 'Theirs', project_id: stranger.inbox }, { temp_id: tempId(70) })]);
    const { reply } = await run(who, [
      command('item_add', { content: 'Nope', project_id: stranger.inbox }),
      command('item_update', { id: real(70), content: 'Hijacked' }),
      command('item_delete', { id: real(70) }),
    ]);
    const errors = Object.values(reply.body.sync_status).map((s) => (s as { error_tag: string }).error_tag);
    expect(errors).toEqual(['PROJECT_NOT_FOUND', 'ITEM_NOT_FOUND', 'ITEM_NOT_FOUND']);
    const theirs = await openTasks(stranger);
    expect(theirs.find((i) => i.id === real(70))?.content).toBe('Theirs');
  });
});
