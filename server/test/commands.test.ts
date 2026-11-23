import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Api, command, person, startServer, type TestServer, tempId } from './harness';

/* The first project creation fails inside the server (not a refusal the app would expect), then works. */
let failCreation = true;
vi.mock('../projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projects')>();
  return {
    ...actual,
    addProject: (...args: Parameters<typeof actual.addProject>) => {
      if (failCreation) {
        failCreation = false;
        throw new Error('The database was busy.');
      }
      return actual.addProject(...args);
    },
  };
});

let server: TestServer;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => server.close());

describe('a command that names a creation which failed inside the request', () => {
  it('waits for a retry, keeps no answer for itself, and completes when the retry sends both again', async () => {
    const who = await person(new Api(server.base));
    const as = new Api(server.base, who.token);
    const parent = command('project_add', { name: 'Parent' }, { temp_id: tempId(60) });
    const child = command('item_add', { content: 'Child', project_id: tempId(60) }, { temp_id: tempId(61) });
    const first = (await as.sync({ commands: [parent, child] })).body.sync_status;
    expect(first[parent.uuid]).toMatchObject({ error_code: 500 });
    expect(first[child.uuid]).toMatchObject({ error_code: 503, error_tag: 'WAITS_FOR_RETRY' });
    const retry = (await as.sync({ commands: [parent, child] })).body.sync_status;
    expect(retry).toEqual({ [parent.uuid]: 'ok', [child.uuid]: 'ok' });
  });

  it('a chain of creations waits as a whole: a comment on a task that waits for a project waits too', async () => {
    failCreation = true;
    const who = await person(new Api(server.base));
    const as = new Api(server.base, who.token);
    const project = command('project_add', { name: 'Chain' }, { temp_id: tempId(62) });
    const task = command('item_add', { content: 'Task', project_id: tempId(62) }, { temp_id: tempId(63) });
    const note = command('note_add', { item_id: tempId(63), content: 'Note' }, { temp_id: tempId(64) });
    const first = (await as.sync({ commands: [project, task, note] })).body.sync_status;
    expect(first[project.uuid]).toMatchObject({ error_code: 500 });
    expect(first[task.uuid]).toMatchObject({ error_code: 503 });
    expect(first[note.uuid]).toMatchObject({ error_code: 503 });
    const retry = (await as.sync({ commands: [project, task, note] })).body.sync_status;
    expect(retry).toEqual({ [project.uuid]: 'ok', [task.uuid]: 'ok', [note.uuid]: 'ok' });
  });
});
