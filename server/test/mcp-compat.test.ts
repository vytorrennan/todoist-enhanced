import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, command, person, startServer, type Person, type TestServer } from './harness';
import { nameMatches } from '../rest';
import { PERSONAL_PROJECT_CEILING } from '../read';

/*
 * What the official Todoist MCP server reads from this server, found by running it against this server. Each test is
 * one of the calls it makes; the end-to-end suite in mcp-e2e/ runs the MCP itself.
 */

let server: TestServer;
let base: Api;
beforeAll(async () => { server = await startServer(); base = new Api(server.base); });
afterAll(async () => server.close());

const as = (who: Person) => base.as(who.token);

describe('the Sync API answers the way the official SDK expects', () => {
  it('a write with no resource types answers with its results only, without resource data', async () => {
    const who = await person(base);
    const body = new URLSearchParams({ commands: JSON.stringify([command('label_add', { name: 'Plain' })]) });
    const reply = await as(who).form('/api/v1/sync', body);
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(['full_sync', 'sync_status', 'sync_token', 'temp_id_mapping']);
  });

  it('reports the plan’s project ceiling when asked, so a new project is not refused for an unknown limit', async () => {
    const who = await person(base);
    const reply = await as(who).sync({ types: ['user_plan_limits'] });
    expect(reply.body.user_plan_limits).toEqual({ current: { maxProjects: PERSONAL_PROJECT_CEILING }, next: null });
  });

  it('reads a due phrase in a command the way the REST API reads it: a day as written, and a repeat rule as a repeat', async () => {
    const who = await person(base);
    const inbox = who.inbox;
    const day = await as(who).sync({ types: ['items'], commands: [command('item_add', { content: 'Dated', project_id: inbox, due: { string: '2030-01-15' } })] });
    const dated = day.body.items.find((item: { content: string }) => item.content === 'Dated');
    expect(dated.due).toMatchObject({ date: '2030-01-15', string: '2030-01-15' });

    const rule = await as(who).sync({ types: ['items'], commands: [command('item_add', { content: 'Weekly', project_id: inbox, due: { string: 'every monday' } })] });
    const weekly = rule.body.items.find((item: { content: string }) => item.content === 'Weekly');
    expect(weekly.due).toMatchObject({ string: 'every monday', is_recurring: true });

    const restDay = await as(who).post('/api/v1/tasks', { content: 'Dated by REST', due_string: '2030-01-15' });
    expect(restDay.body.due).toMatchObject({ date: '2030-01-15' });
  });

  it('refuses a due phrase it cannot read, and names the phrase', async () => {
    const who = await person(base);
    const reply = await as(who).sync({ types: ['items'], commands: [command('item_add', { content: 'Nonsense', project_id: who.inbox, due: { string: 'whenever the moon is blue' } })] });
    const status = Object.values(reply.body.sync_status)[0] as { error_tag: string; error: string };
    expect(status.error_tag).toBe('INVALID_DATE');
    expect(status.error).toContain('whenever the moon is blue');
  });
});

describe('finding a project by its name', () => {
  it('reads a name with text anywhere in it, a wildcard that fits the whole name, and a literal star', () => {
    expect(nameMatches('Acme Corp', 'acme')).toBe(true);
    expect(nameMatches('Acme Corp', '*acme*')).toBe(true);
    expect(nameMatches('Acme Corp', 'ACME*')).toBe(true);
    expect(nameMatches('Acme Corp', '*corp')).toBe(true);
    expect(nameMatches('Corp Acme', 'acme*')).toBe(false);
    expect(nameMatches('anything', '')).toBe(true);
    expect(nameMatches('a*b', 'a\\*b')).toBe(true);
    expect(nameMatches('axb', 'a\\*b')).toBe(false);
    expect(nameMatches('a.b', 'a.b')).toBe(true);
    expect(nameMatches('axb', 'a.b')).toBe(false);
  });

  it('answers a search with many stars at once, with no backtracking to hang the server', () => {
    // A matcher that backtracks through every split of the name takes exponential time on this. It must answer at once.
    const query = `${'*a'.repeat(60)}*b`;
    expect(nameMatches('a'.repeat(120), query)).toBe(false);
    expect(nameMatches(`${'a'.repeat(120)}b`, query)).toBe(true);
  });

  it('finds only the active projects the person can see, and no one else’s', async () => {
    const alice = await person(base);
    const bob = await person(base);
    const create = async (who: Person, name: string) => {
      const temp = randomUUID();
      const reply = await as(who).sync({ commands: [command('project_add', { name }, { temp_id: temp })] });
      expect(Object.values(reply.body.sync_status)[0]).toBe('ok');
      return reply.body.temp_id_mapping[temp] as string;
    };
    await create(alice, 'Acme Corp');
    await create(alice, 'Clients');
    const old = await create(alice, 'Old acme');
    await create(bob, 'Acme Secret');
    await as(alice).sync({ commands: [command('project_archive', { id: old })] });

    const names = async (who: Person, query: string) => {
      const reply = await as(who).get(`/api/v1/projects/search?query=${encodeURIComponent(query)}`);
      expect(reply.status).toBe(200);
      return reply.body.results.map((project: { name: string }) => project.name);
    };
    expect(await names(alice, 'acme')).toEqual(['Acme Corp']);
    expect(await names(alice, 'ACME*')).toEqual(['Acme Corp']);
    expect(await names(alice, '*corp')).toEqual(['Acme Corp']);
    expect(await names(bob, 'acme')).toEqual(['Acme Secret']);
    expect(await names(alice, 'nothing like this')).toEqual([]);
  });

  it('pages the results with a cursor, the way the list does', async () => {
    const who = await person(base);
    for (const name of ['Pager one', 'Pager two', 'Pager three']) {
      await as(who).sync({ commands: [command('project_add', { name })] });
    }
    const first = await as(who).get('/api/v1/projects/search?query=pager&limit=2');
    expect(first.body.results).toHaveLength(2);
    expect(first.body.next_cursor).toBe('2');
    const second = await as(who).get(`/api/v1/projects/search?query=pager&limit=2&cursor=${first.body.next_cursor}`);
    expect(second.body.results).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
  });
});

describe('filters that name one day', () => {
  it('finds the tasks due on a day with due: and the tasks scheduled for it with date:, and refuses a day that does not exist', async () => {
    const who = await person(base);
    const dated = (content: string, date: string) => command('item_add', { content, project_id: who.inbox, due: { date } });
    await as(who).sync({ commands: [dated('Due that day', '2030-01-15'), dated('Due another day', '2030-01-16')] });

    const find = (query: string) => as(who).get(`/api/v1/tasks/filter?query=${encodeURIComponent(query)}`);
    const dueOn = await find('due: 2030-01-15');
    expect(dueOn.status).toBe(200);
    expect(dueOn.body.results.map((task: { content: string }) => task.content)).toEqual(['Due that day']);
    expect((await find('date: 2030-01-15')).body.results.map((task: { content: string }) => task.content)).toEqual(['Due that day']);

    const impossible = await find('due: 2030-02-30');
    expect(impossible.status).toBe(400);
    expect(impossible.body.error_tag).toBe('INVALID_FILTER');
  });
});
