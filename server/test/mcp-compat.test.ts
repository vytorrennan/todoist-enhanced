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

  it('matches names without regard to case, including a Greek final sigma and a German sharp s', () => {
    expect(nameMatches('ΟΣ', 'Σ')).toBe(true);
    expect(nameMatches('ΟΣ', 'ος')).toBe(true);
    expect(nameMatches('ΟΣ', 'οσ')).toBe(true);
    expect(nameMatches('Straße', 'STRASSE')).toBe(true);
    expect(nameMatches('Strasse', 'straße')).toBe(true);
    expect(nameMatches('Straße', 'strasse*')).toBe(true);
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

/** Makes one thing through the Sync API and returns the id the server gave it. */
async function createdId(who: Person, type: string, args: Record<string, unknown>): Promise<string> {
  const temp = randomUUID();
  const reply = await as(who).sync({ commands: [command(type, args, { temp_id: temp })] });
  expect(Object.values(reply.body.sync_status)[0]).toBe('ok');
  return reply.body.temp_id_mapping[temp] as string;
}

/** Shares a project with a person, who accepts it, as the app does. */
async function shareAndAccept(owner: Person, project: string, guest: Person): Promise<void> {
  await as(owner).sync({ commands: [command('share_project', { project_id: project, email: guest.email, role: 'READ_WRITE' })] });
  const notes = (await as(guest).sync({ types: ['live_notifications'] })).body.live_notifications as Array<Record<string, any>>;
  const invite = notes.find((note) => note.notification_type === 'share_invitation_sent' && !note.answered);
  expect(invite).toBeDefined();
  const accepted = await as(guest).sync({ commands: [command('accept_invitation', { invitation_id: invite?.invitation_id, invitation_secret: invite?.invitation_secret })] });
  expect(Object.values(accepted.body.sync_status)[0]).toBe('ok');
}

const names = (body: { results: Array<{ name: string } | string> }) => body.results.map((item) => (typeof item === 'string' ? item : item.name));

describe('the labels the official find-labels reads', () => {
  it('reads the personal labels a page at a time, in the order the person keeps them', async () => {
    const who = await person(base);
    for (const name of ['Page one', 'Page two', 'Page three']) await as(who).sync({ commands: [command('label_add', { name })] });
    const first = await as(who).get('/api/v1/labels?limit=2');
    expect(names(first.body)).toEqual(['Page one', 'Page two']);
    expect(first.body.next_cursor).toBe('2');
    const second = await as(who).get(`/api/v1/labels?limit=2&cursor=${first.body.next_cursor}`);
    expect(names(second.body)).toEqual(['Page three']);
    expect(second.body.next_cursor).toBeNull();
  });

  it('finds personal labels by part of a name or a wildcard, a literal star, and never another person’s label', async () => {
    const alice = await person(base);
    const bob = await person(base);
    for (const name of ['Work', 'Errands at work', 'c++', 'Rated *', 'Home']) await as(alice).sync({ commands: [command('label_add', { name })] });
    await as(bob).sync({ commands: [command('label_add', { name: 'Bobs work' })] });
    const search = async (who: Person, query: string) => names((await as(who).get(`/api/v1/labels/search?query=${encodeURIComponent(query)}`)).body);

    expect(await search(alice, 'WORK')).toEqual(['Work', 'Errands at work']);
    expect(await search(alice, 'work*')).toEqual(['Work']);
    expect(await search(alice, 'c++')).toEqual(['c++']);
    expect(await search(alice, 'Rated \\*')).toEqual(['Rated *']);
    expect(await search(alice, 'nothing like this')).toEqual([]);
    expect(await search(bob, 'work')).toEqual(['Bobs work']);
  });

  it('pages a label search with a cursor, and refuses a search that names no text', async () => {
    const who = await person(base);
    for (const name of ['Pager one', 'Pager two', 'Pager three']) await as(who).sync({ commands: [command('label_add', { name })] });
    const first = await as(who).get('/api/v1/labels/search?query=pager&limit=2');
    expect(names(first.body)).toEqual(['Pager one', 'Pager two']);
    expect(first.body.next_cursor).toBe('2');
    const second = await as(who).get(`/api/v1/labels/search?query=pager&limit=2&cursor=${first.body.next_cursor}`);
    expect(names(second.body)).toEqual(['Pager three']);
    expect(second.body.next_cursor).toBeNull();

    const missing = await as(who).get('/api/v1/labels/search');
    expect(missing.status).toBe(400);
    expect(missing.body.error_tag).toBe('INVALID_ARGUMENT');
  });

  it('leaves out a label that was deleted', async () => {
    const who = await person(base);
    const gone = await createdId(who, 'label_add', { name: 'Deleted tag' });
    await as(who).sync({ commands: [command('label_add', { name: 'Kept tag' })] });
    await as(who).sync({ commands: [command('label_delete', { id: gone })] });
    expect(names((await as(who).get('/api/v1/labels/search?query=tag')).body)).toEqual(['Kept tag']);
    expect(names((await as(who).get('/api/v1/labels')).body)).toEqual(['Kept tag']);
  });

  it('lists the labels on the tasks of a shared project to everyone in it, to no one else, and not the labels of a project nobody shares', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const stranger = await person(base);
    const shared = await createdId(owner, 'project_add', { name: 'Shared with guest' });
    const mine = await createdId(owner, 'project_add', { name: 'Owner only' });
    await as(owner).sync({ commands: [
      command('item_add', { content: 'Shared task', project_id: shared, labels: ['Client', 'waiting', 'zeta', 'Alpha'] }),
      command('item_add', { content: 'Owner task', project_id: mine, labels: ['Secret tag'] }),
    ] });
    await shareAndAccept(owner, shared, guest);
    await as(guest).sync({ commands: [command('label_add', { name: 'WAITING' })] });

    const seen = await as(guest).get('/api/v1/labels/shared');
    expect(seen.status).toBe(200);
    expect(seen.body.results).toEqual(['Alpha', 'Client', 'waiting', 'zeta']);
    expect((await as(guest).get('/api/v1/labels/shared?omit_personal=true')).body.results).toEqual(['Alpha', 'Client', 'zeta']);
    const ownerSees = (await as(owner).get('/api/v1/labels/shared')).body.results as string[];
    expect(ownerSees).toEqual(['Alpha', 'Client', 'waiting', 'zeta']);
    expect(ownerSees).not.toContain('Secret tag');
    expect((await as(stranger).get('/api/v1/labels/shared')).body.results).toEqual([]);

    await as(owner).sync({ commands: [command('delete_collaborator', { project_id: shared, email: guest.email })] });
    expect((await as(guest).get('/api/v1/labels/shared')).body.results).toEqual([]);
  });

  it('pages the shared label names with a cursor', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const project = await createdId(owner, 'project_add', { name: 'Many labels' });
    await as(owner).sync({ commands: [command('item_add', { content: 'Tagged', project_id: project, labels: ['b', 'a', 'c'] })] });
    await shareAndAccept(owner, project, guest);
    const first = await as(guest).get('/api/v1/labels/shared?limit=2');
    expect(first.body.results).toEqual(['a', 'b']);
    expect(first.body.next_cursor).toBe('2');
    const second = await as(guest).get(`/api/v1/labels/shared?limit=2&cursor=${first.body.next_cursor}`);
    expect(second.body.results).toEqual(['c']);
    expect(second.body.next_cursor).toBeNull();
  });
});

describe('the sections the official find-sections searches by name', () => {
  it('finds the sections of a project whose name matches, and only that project’s when it is named', async () => {
    const who = await person(base);
    const work = await createdId(who, 'project_add', { name: 'Work' });
    const home = await createdId(who, 'project_add', { name: 'Home' });
    const gone = await createdId(who, 'section_add', { name: 'Gap gone', project_id: work });
    await as(who).sync({ commands: [
      command('section_add', { name: 'Gap analysis', project_id: work }),
      command('section_add', { name: 'Next gap', project_id: work }),
      command('section_add', { name: 'Garden', project_id: work }),
      command('section_add', { name: 'Gap elsewhere', project_id: home }),
    ] });
    await as(who).sync({ commands: [command('section_delete', { id: gone })] });
    const archived = await createdId(who, 'section_add', { name: 'Gap archived', project_id: work });
    await as(who).sync({ commands: [command('section_archive', { id: archived })] });

    const search = async (query: string, project?: string) => {
      const scope = project ? `&project_id=${project}` : '';
      return names((await as(who).get(`/api/v1/sections/search?query=${encodeURIComponent(query)}${scope}`)).body).sort();
    };
    expect(await search('GAP', work)).toEqual(['Gap analysis', 'Next gap']);
    expect(await search('gap*', work)).toEqual(['Gap analysis']);
    expect(await search('gap')).toEqual(['Gap analysis', 'Gap elsewhere', 'Next gap']);
    expect(await search('nothing like this', work)).toEqual([]);
    expect(await search('archived', work)).toEqual([]);
  });

  it('shows a person the sections of a project shared with them, and no one else the sections of it', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const stranger = await person(base);
    const project = await createdId(owner, 'project_add', { name: 'Shared sections' });
    await as(owner).sync({ commands: [command('section_add', { name: 'Shared section', project_id: project })] });
    await shareAndAccept(owner, project, guest);
    const find = (who: Person) => as(who).get(`/api/v1/sections/search?query=shared&project_id=${project}`);
    expect(names((await find(guest)).body)).toEqual(['Shared section']);
    expect((await find(stranger)).body.results).toEqual([]);
  });

  it('pages a section search with a cursor, and refuses a search that names no text', async () => {
    const who = await person(base);
    const project = await createdId(who, 'project_add', { name: 'Paged sections' });
    for (const name of ['Pass one', 'Pass two', 'Pass three']) await as(who).sync({ commands: [command('section_add', { name, project_id: project })] });
    const first = await as(who).get(`/api/v1/sections/search?query=pass&project_id=${project}&limit=2`);
    expect(names(first.body)).toEqual(['Pass one', 'Pass two']);
    expect(first.body.next_cursor).toBe('2');
    const second = await as(who).get(`/api/v1/sections/search?query=pass&project_id=${project}&limit=2&cursor=${first.body.next_cursor}`);
    expect(names(second.body)).toEqual(['Pass three']);
    expect(second.body.next_cursor).toBeNull();

    const missing = await as(who).get(`/api/v1/sections/search?project_id=${project}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error_tag).toBe('INVALID_ARGUMENT');
  });
});

describe('a task is found by its label, and shared labels stay current', () => {
  it('filters tasks by a label whatever the case or accents of the spelling on the task', async () => {
    const who = await person(base);
    const project = await createdId(who, 'project_add', { name: 'Spelled labels' });
    await as(who).sync({ commands: [
      command('item_add', { content: 'Upper', project_id: project, labels: ['Client'] }),
      command('item_add', { content: 'Lower', project_id: project, labels: ['client'] }),
      command('item_add', { content: 'Accented', project_id: project, labels: ['Café'] }),
      command('item_add', { content: 'Other', project_id: project, labels: ['Clients'] }),
    ] });
    const contents = async (label: string) => ((await as(who).get(`/api/v1/tasks?project_id=${project}&label=${encodeURIComponent(label)}`)).body.results as Array<{ content: string }>)
      .map((task) => task.content).sort();
    expect(await contents('client')).toEqual(['Lower', 'Upper']);
    expect(await contents('CLIENT')).toEqual(['Lower', 'Upper']);
    expect(await contents('cafe')).toEqual(['Accented']);
    expect(await contents('Café')).toEqual(['Accented']);
  });

  it('shows a label a task gains, drops it once the task is completed, and never lists one that only completed tasks carry', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const project = await createdId(owner, 'project_add', { name: 'Changing labels' });
    await as(owner).sync({ commands: [command('item_add', { content: 'First', project_id: project, labels: ['Early'] })] });
    await shareAndAccept(owner, project, guest);
    expect((await as(guest).get('/api/v1/labels/shared')).body.results).toEqual(['Early']);

    const task = await createdId(owner, 'item_add', { content: 'Second', project_id: project, labels: ['Late'] });
    expect((await as(guest).get('/api/v1/labels/shared')).body.results).toEqual(['Early', 'Late']);

    await as(owner).sync({ commands: [command('item_update', { id: task, labels: ['Later'] })] });
    expect((await as(guest).get('/api/v1/labels/shared')).body.results).toEqual(['Early', 'Later']);

    await as(owner).sync({ commands: [command('item_complete', { id: task })] });
    expect((await as(guest).get('/api/v1/labels/shared')).body.results).toEqual(['Early']);

    const done = await createdId(owner, 'item_add', { content: 'Finished', project_id: project, labels: ['Finished'] });
    await as(owner).sync({ commands: [command('item_complete', { id: done })] });
    expect((await as(guest).get('/api/v1/labels/shared')).body.results).toEqual(['Early']);
  });

  it('lists to a project owner the labels a collaborator adds in their shared project', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const project = await createdId(owner, 'project_add', { name: 'Collaborated' });
    await shareAndAccept(owner, project, guest);
    expect((await as(owner).get('/api/v1/labels/shared')).body.results).toEqual([]);
    await as(guest).sync({ commands: [command('item_add', { content: 'From guest', project_id: project, labels: ['From guest'] })] });
    expect((await as(owner).get('/api/v1/labels/shared')).body.results).toEqual(['From guest']);
  });

  it('leaves the person’s own labels out of the shared list before it is paged, when asked', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const project = await createdId(owner, 'project_add', { name: 'Omitting' });
    await as(owner).sync({ commands: [command('item_add', { content: 'Tagged', project_id: project, labels: ['a', 'b', 'c'] })] });
    await shareAndAccept(owner, project, guest);
    await as(guest).sync({ commands: [command('label_add', { name: 'B' })] });

    const omitted = await as(guest).get('/api/v1/labels/shared?omit_personal=true&limit=2');
    expect(omitted.body.results).toEqual(['a', 'c']);
    expect(omitted.body.next_cursor).toBeNull();
    const all = await as(guest).get('/api/v1/labels/shared?limit=2');
    expect(all.body.results).toEqual(['a', 'b']);
    expect(all.body.next_cursor).toBe('2');
  });
});

describe('a long list is paged in the database, every match once across the pages', () => {
  /** Follows next_cursor from the first page to the last, as the official tool does, and returns every name and the page count. */
  async function walk(who: Person, route: string, params: Record<string, string>, limit: number) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = new URLSearchParams({ ...params, limit: String(limit) });
      if (cursor !== null) query.set('cursor', cursor);
      const reply = await as(who).get(`${route}?${query}`);
      expect(reply.status).toBe(200);
      seen.push(...names(reply.body));
      cursor = reply.body.next_cursor as string | null;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(20);
    } while (cursor !== null);
    return { seen, pages };
  }

  it('pages the labels, and a label search through them, with each matching label in order on exactly one page', async () => {
    const who = await person(base);
    const labels = Array.from({ length: 130 }, (_, n) => `Bulk ${String(n).padStart(3, '0')}`);
    await as(who).sync({ commands: labels.map((name) => command('label_add', { name })) });
    const expected = labels;

    const search = await walk(who, '/api/v1/labels/search', { query: 'bulk' }, 25);
    expect(search.pages).toBe(Math.ceil(labels.length / 25));
    expect(search.seen).toEqual(expected);

    const list = await walk(who, '/api/v1/labels', {}, 25);
    expect(list.seen).toEqual(expected);
  });

  it('pages a section search through a long project, with each matching section in order on exactly one page', async () => {
    const who = await person(base);
    const project = await createdId(who, 'project_add', { name: 'Long project' });
    const sections = Array.from({ length: 75 }, (_, n) => `Many ${String(n).padStart(2, '0')}`);
    await as(who).sync({ commands: sections.map((name) => command('section_add', { name, project_id: project })) });

    const found = await walk(who, '/api/v1/sections/search', { query: 'many', project_id: project }, 20);
    expect(found.pages).toBe(Math.ceil(sections.length / 20));
    expect(found.seen).toEqual(sections);
  });

  it('answers a cursor or a limit too large for the database with the first page, not a server error', async () => {
    const who = await person(base);
    const project = await createdId(who, 'project_add', { name: 'Huge numbers' });
    await as(who).sync({ commands: [command('label_add', { name: 'Huge one' }), command('section_add', { name: 'Huge section', project_id: project })] });
    for (const route of ['/api/v1/labels', '/api/v1/labels/search?query=huge', '/api/v1/sections/search?query=huge&project_id=' + project]) {
      for (const extra of ['cursor=1e100', 'limit=1e100', 'cursor=9007199254740993&limit=1']) {
        const reply = await as(who).get(`${route}${route.includes('?') ? '&' : '?'}${extra}`);
        expect(reply.status, `${route} ${extra}`).toBe(200);
        expect(reply.body.results.length, `${route} ${extra}`).toBeGreaterThan(0);
      }
    }
  });
});
