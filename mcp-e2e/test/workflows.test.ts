/* eslint-disable @typescript-eslint/no-explicit-any -- tool and API replies are untyped JSON; each test asserts the fields it reads. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { type Account, type Assistant, call, connectAssistant, MCP_ENTRY, type Reply, register, removeDir, RunningServer, scratchDir, startServer, sync } from './support.js';

/*
 * The official Todoist MCP server, run as an assistant runs it, against this server through TODOIST_BASE_URL.
 * Every tool call here is one an assistant makes; a passing test is a workflow the assistant can finish.
 */

let server: RunningServer;
let dataDir: string;
let owner: Account;
let assistant: Assistant;

beforeAll(async () => {
  dataDir = scratchDir('mcp');
  server = await startServer(dataDir);
  owner = await register(server.base, 'Owner');
  assistant = await connectAssistant(server.base, owner.token);
}, 60_000);

afterAll(async () => {
  await assistant?.close();
  await server?.stop();
  if (dataDir) removeDir(dataDir);
});

/** A call that did not do what it was asked: the call failed, or a batch put the item among its failures. */
const refused = (reply: Reply): boolean => reply.isError || (reply.data?.failures?.length ?? 0) > 0;

/** The ids of the items a tool created, in order, failing the test if any item was refused. */
function createdIds(reply: { isError: boolean; text: string; data: any }, key: string): string[] {
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.data.failures, reply.text).toEqual([]);
  return reply.data[key].map((item: { id: string }) => item.id);
}

describe('the official tools, against this server', () => {
  it('offers the tools these workflows call', async () => {
    const { tools } = await assistant.client.listTools();
    const names = tools.map((tool: { name: string }) => tool.name);
    for (const name of [
      'user-info', 'add-projects', 'find-projects', 'update-projects', 'add-tasks', 'find-tasks', 'update-tasks',
      'complete-tasks', 'uncomplete-tasks', 'find-completed-tasks', 'add-filters', 'find-filters', 'update-filters',
      'delete-object', 'fetch-object',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('tells the assistant who it is signed in as', async () => {
    const reply = await call(assistant, 'user-info');
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.data).toMatchObject({ userId: owner.id, timezone: 'UTC' });
  });

  it('keeps a task from creation to deletion', async () => {
    const project = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Launch' }] }), 'projects')[0];

    const added = createdIds(await call(assistant, 'add-tasks', {
      tasks: [
        { content: 'Write spec', projectId: project, priority: 'p2', dueString: '2030-01-15', description: 'Draft first' },
        { content: 'Ship it', projectId: project, description: 'After review' },
      ],
    }), 'tasks');
    const [spec, ship] = added;
    expect(added).toHaveLength(2);

    const open = await call(assistant, 'find-tasks', { projectId: project });
    expect(open.data.tasks.map((task: { content: string }) => task.content).sort()).toEqual(['Ship it', 'Write spec']);
    expect(open.data.tasks.find((task: { id: string }) => task.id === spec)).toMatchObject({
      priority: 'p2', dueDate: '2030-01-15', description: 'Draft first',
    });

    const updated = await call(assistant, 'update-tasks', { tasks: [{ id: spec, content: 'Write the spec', priority: 'p1' }] });
    expect(updated.isError, updated.text).toBe(false);
    expect(updated.data.updatedTaskIds).toEqual([spec]);
    const afterUpdate = await call(assistant, 'find-tasks', { projectId: project });
    expect(afterUpdate.data.tasks.find((task: { id: string }) => task.id === spec)).toMatchObject({ content: 'Write the spec', priority: 'p1' });

    const completed = await call(assistant, 'complete-tasks', { ids: [ship] });
    expect(completed.isError, completed.text).toBe(false);
    expect(completed.data.completed).toEqual([ship]);
    const done = await call(assistant, 'find-completed-tasks', { getBy: 'completion', since: '2000-01-01', until: '2100-01-01' });
    expect(done.data.tasks.map((task: { id: string }) => task.id)).toEqual([ship]);
    const stillOpen = await call(assistant, 'find-tasks', { projectId: project });
    expect(stillOpen.data.tasks.map((task: { id: string }) => task.id)).toEqual([spec]);

    const reopened = await call(assistant, 'uncomplete-tasks', { ids: [ship] });
    expect(reopened.data.uncompleted).toEqual([ship]);
    expect((await call(assistant, 'find-tasks', { projectId: project })).data.totalCount).toBe(2);

    const deleted = await call(assistant, 'delete-object', { type: 'task', id: ship });
    expect(deleted.isError, deleted.text).toBe(false);
    expect(deleted.data).toMatchObject({ success: true, deletedEntity: { type: 'task', id: ship } });
    expect((await call(assistant, 'find-tasks', { projectId: project })).data.tasks.map((task: { id: string }) => task.id)).toEqual([spec]);
    const gone = await call(assistant, 'fetch-object', { type: 'task', id: ship });
    expect(gone.isError).toBe(true);
  });

  it('nests a project under another, renames it, and deletes it', async () => {
    const parent = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Clients' }] }), 'projects')[0];
    const child = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Acme', parentId: parent }] }), 'projects')[0];

    const found = await call(assistant, 'find-projects', { searchText: 'Acme' });
    expect(found.data.projects).toEqual([expect.objectContaining({ id: child, name: 'Acme' })]);
    expect((await call(assistant, 'fetch-object', { type: 'project', id: child })).data.object).toMatchObject({ id: child, name: 'Acme' });

    const renamed = await call(assistant, 'update-projects', { projects: [{ id: child, name: 'Acme Corp' }] });
    expect(renamed.isError, renamed.text).toBe(false);
    expect((await call(assistant, 'find-projects', { searchText: 'Acme Corp' })).data.projects.map((p: { id: string }) => p.id)).toEqual([child]);

    expect((await call(assistant, 'delete-object', { type: 'project', id: child })).data.success).toBe(true);
    expect((await call(assistant, 'find-projects', { searchText: 'Acme' })).data.projects).toEqual([]);
  });

  it('groups tasks into sections, finds them there, and removes the section', async () => {
    const project = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Sections' }] }), 'projects')[0];
    const section = createdIds(await call(assistant, 'add-sections', { sections: [{ name: 'This week', projectId: project }] }), 'sections')[0];
    const [task] = createdIds(await call(assistant, 'add-tasks', { tasks: [{ content: 'In a section', projectId: project, sectionId: section }] }), 'tasks');

    expect((await call(assistant, 'find-sections', { projectId: project })).data.sections.map((s: { id: string }) => s.id)).toEqual([section]);
    expect((await call(assistant, 'find-tasks', { sectionId: section })).data.tasks.map((t: { id: string }) => t.id)).toEqual([task]);
    expect((await call(assistant, 'delete-object', { type: 'section', id: section })).data.success).toBe(true);
    expect((await call(assistant, 'find-sections', { projectId: project })).data.sections).toEqual([]);
  });

  it('saves a filter, and finds the tasks it matches', async () => {
    const project = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Filters' }] }), 'projects')[0];
    const [urgent, later] = createdIds(await call(assistant, 'add-tasks', {
      tasks: [
        { content: 'Fix outage', projectId: project, priority: 'p1' },
        { content: 'Tidy desk', projectId: project, priority: 'p4' },
      ],
    }), 'tasks');

    const saved = createdIds(await call(assistant, 'add-filters', { filters: [{ name: 'Top priority', query: 'p1' }] }), 'filters')[0];
    expect((await call(assistant, 'find-filters', { search: 'Top priority' })).data.filters).toEqual([
      expect.objectContaining({ id: saved, name: 'Top priority', query: 'p1' }),
    ]);

    const matching = await call(assistant, 'find-tasks', { filter: 'p1' });
    expect(matching.isError, matching.text).toBe(false);
    const matchingIds = matching.data.tasks.map((task: { id: string }) => task.id);
    expect(matchingIds).toContain(urgent);
    expect(matchingIds).not.toContain(later);

    const renamed = await call(assistant, 'update-filters', { filters: [{ id: saved, name: 'Urgent work' }] });
    expect(renamed.isError, renamed.text).toBe(false);
    expect((await call(assistant, 'find-filters', { search: 'Urgent work' })).data.filters.map((f: { id: string }) => f.id)).toEqual([saved]);

    expect((await call(assistant, 'delete-object', { type: 'filter', id: saved })).data.success).toBe(true);
    expect((await call(assistant, 'find-filters', { search: 'Urgent work' })).data.filters).toEqual([]);
  });

  it('reads a due phrase the way the app does, and a repeat rule as a repeat', async () => {
    const project = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Routines' }] }), 'projects')[0];
    const [weekly] = createdIds(await call(assistant, 'add-tasks', {
      tasks: [{ content: 'Water plants', projectId: project, dueString: 'every monday' }],
    }), 'tasks');
    const task = (await call(assistant, 'find-tasks', { projectId: project })).data.tasks.find((t: { id: string }) => t.id === weekly);
    // The assistant reads a repeat rule's phrase in this field, so a recurring task says what it repeats.
    expect(task).toMatchObject({ recurring: 'every monday' });
  });
});

describe('authentication', () => {
  it('will not start without a token', async () => {
    const child = spawn(process.execPath, [MCP_ENTRY], { env: getDefaultEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((done) => child.once('exit', (exit) => done(exit)));
    expect(code).not.toBe(0);
    expect(stderr).toContain('TODOIST_API_KEY is not set');
  });

  it('refuses every tool call for a token this server does not know', async () => {
    const stranger = await connectAssistant(server.base, 'not-a-real-token');
    try {
      const reply = await call(stranger, 'user-info');
      expect(reply.isError).toBe(true);
      expect(reply.text).not.toContain(owner.id);
    } finally {
      await stranger.close();
    }
  });

  it('stops working once its token is signed out, and another person’s token carries on', async () => {
    const person = await register(server.base, 'Signed out');
    const first = await connectAssistant(server.base, person.token);
    const second = await register(server.base, 'Unused');
    try {
      expect((await call(first, 'user-info')).isError).toBe(false);
      const out = await fetch(`${server.base}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${person.token}` } });
      expect(out.ok).toBe(true);
      expect((await call(first, 'user-info')).isError).toBe(true);
      // Another person's session is untouched by it.
      expect((await call(await connectAssistant(server.base, second.token), 'user-info')).isError).toBe(false);
    } finally {
      await first.close();
    }
  });
});

describe('account isolation', () => {
  let alice: Account;
  let bob: Account;
  let aliceAssistant: Assistant;
  let bobAssistant: Assistant;
  let secretProject: string;
  let secretTask: string;

  beforeAll(async () => {
    alice = await register(server.base, 'Alice');
    bob = await register(server.base, 'Bob');
    aliceAssistant = await connectAssistant(server.base, alice.token);
    bobAssistant = await connectAssistant(server.base, bob.token);
    secretProject = createdIds(await call(aliceAssistant, 'add-projects', { projects: [{ name: 'Alice private plans' }] }), 'projects')[0];
    secretTask = createdIds(await call(aliceAssistant, 'add-tasks', {
      tasks: [{ content: 'Alice confidential note', projectId: secretProject }],
    }), 'tasks')[0];
  }, 60_000);

  afterAll(async () => {
    await aliceAssistant?.close();
    await bobAssistant?.close();
  });

  it('keeps another person’s projects and tasks out of every list', async () => {
    const projects = await call(bobAssistant, 'find-projects', {});
    expect(JSON.stringify(projects.data)).not.toContain('Alice private plans');
    const tasks = await call(bobAssistant, 'find-tasks', {});
    expect(JSON.stringify(tasks.data)).not.toContain('Alice confidential note');
    const search = await call(bobAssistant, 'search', { query: 'confidential' });
    expect(JSON.stringify(search.data ?? search.text)).not.toContain('Alice confidential note');
  });

  it('refuses to read, change, complete or delete another person’s task, and leaves it as it was', async () => {
    expect((await call(bobAssistant, 'fetch-object', { type: 'task', id: secretTask })).isError).toBe(true);
    expect(refused(await call(bobAssistant, 'update-tasks', { tasks: [{ id: secretTask, content: 'Hijacked' }] }))).toBe(true);
    expect(refused(await call(bobAssistant, 'complete-tasks', { ids: [secretTask] }))).toBe(true);
    expect(refused(await call(bobAssistant, 'delete-object', { type: 'task', id: secretTask }))).toBe(true);

    const still = await call(aliceAssistant, 'find-tasks', { projectId: secretProject });
    expect(still.data.tasks).toEqual([expect.objectContaining({ id: secretTask, content: 'Alice confidential note', checked: false })]);
  });

  it('refuses to add a task to another person’s project', async () => {
    const reply = await call(bobAssistant, 'add-tasks', { tasks: [{ content: 'Sneaky', projectId: secretProject }] });
    expect(reply.data.totalCount).toBe(0);
    expect(reply.data.failures).toHaveLength(1);
    expect((await call(aliceAssistant, 'find-tasks', { projectId: secretProject })).data.totalCount).toBe(1);
  });

  it('answers a task of another person the same way as one that does not exist', async () => {
    const unknown = await call(bobAssistant, 'fetch-object', { type: 'task', id: '0'.repeat(32) });
    const theirs = await call(bobAssistant, 'fetch-object', { type: 'task', id: secretTask });
    expect(theirs.isError).toBe(true);
    expect(theirs.text.replace(secretTask, '<id>')).toBe(unknown.text.replace('0'.repeat(32), '<id>'));
  });
});

describe('error handling', () => {
  it('refuses a call with a missing field, and names the field', async () => {
    const reply = await call(assistant, 'complete-tasks', {});
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('ids');
  });

  it('refuses a tool name that does not exist', async () => {
    await expect(assistant.client.callTool({ name: 'no-such-tool', arguments: {} })).rejects.toThrow();
  });

  it('reports a batch with a bad item as a partial success, and keeps the good one', async () => {
    const project = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Partial' }] }), 'projects')[0];
    const reply = await call(assistant, 'add-tasks', {
      tasks: [
        { content: 'Good one', projectId: project },
        { content: 'Bad one', projectId: '0'.repeat(32) },
      ],
    });
    expect(reply.data.successCount).toBe(1);
    expect(reply.data.failureCount).toBe(1);
    expect(reply.data.failures[0].item).toBe('Bad one');
    expect((await call(assistant, 'find-tasks', { projectId: project })).data.tasks.map((t: { content: string }) => t.content)).toEqual(['Good one']);
  });

  it('reports an error when a task is completed twice, without losing the first completion', async () => {
    const project = createdIds(await call(assistant, 'add-projects', { projects: [{ name: 'Twice' }] }), 'projects')[0];
    const task = createdIds(await call(assistant, 'add-tasks', { tasks: [{ content: 'Once', projectId: project }] }), 'tasks')[0];
    expect((await call(assistant, 'complete-tasks', { ids: [task] })).data.completed).toEqual([task]);
    const again = await call(assistant, 'complete-tasks', { ids: [task] });
    expect(refused(again)).toBe(true);
    expect(again.data.failures[0].error).toContain('already completed');
    expect((await call(assistant, 'find-completed-tasks', { getBy: 'completion', since: '2000-01-01', until: '2100-01-01' })).data.tasks.map((t: { id: string }) => t.id)).toContain(task);
  });

  it('keeps answering, with a failure, while the server is down', async () => {
    const dir = scratchDir('mcp-restart');
    const local = await startServer(dir);
    const person = await register(local.base, 'Restart');
    const link = await connectAssistant(local.base, person.token);
    try {
      expect((await call(link, 'user-info')).isError).toBe(false);
      await local.stop();
      const down = await call(link, 'user-info');
      expect(down.isError).toBe(true);
      // The assistant process is still alive: a second call is answered, not dropped.
      expect((await call(link, 'user-info')).isError).toBe(true);
    } finally {
      await link.close();
      removeDir(dir);
    }
  }, 60_000);

  it('refuses a sync write with a token it does not know', async () => {
    const reply = await sync(server.base, 'not-a-real-token', [{ type: 'project_add', uuid: '00000000-0000-4000-8000-000000000001', args: { name: 'x' }, temp_id: 't' }]);
    expect(reply.status).toBe(401);
  });
});

describe('known gaps', () => {
  // Recorded, not hidden. Each test fails today, so vitest expects it to fail and the suite stays green. Once the gap is
  // closed, the test passes, vitest reports that as an error, and the marker comes off.
  it.fails('reads the signed-in user through the Sync API, as get-user-status does', async () => {
    const reply = await call(assistant, 'get-user-status');
    expect(reply.isError, reply.text).toBe(false);
  });
});
