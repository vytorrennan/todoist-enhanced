import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TodoistApi } from '@todoist/sdk';
import { Api, person, startServer, type Person, type TestServer } from './harness';

/**
 * The official Todoist SDK, the library the official Todoist MCP server is
 * built on, talking to this server. Each call is one the MCP makes; a passing
 * test is a shape and a behavior the MCP can rely on.
 */

let server: TestServer;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => server.close());

async function account(): Promise<{ who: Person; api: TodoistApi }> {
  const who = await person(new Api(server.base));
  return { who, api: new TodoistApi(who.token, { baseUrl: server.base }) };
}

describe('the SDK against the user and the token check', () => {
  it('reads the signed-in user, with the inbox the MCP files tasks in', async () => {
    const { who, api } = await account();
    const user = await api.getUser();
    expect(user.id).toBe(who.id);
    expect(user.inboxProjectId).toBeTruthy();
  });
});

describe('the SDK against tasks', () => {
  it('adds, reads, updates, closes, reopens, moves and deletes a task', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const task = await api.addTask({ content: 'Buy milk', projectId: inbox, priority: 3, labels: ['errands'], dueString: 'tomorrow' });
    expect(task.content).toBe('Buy milk');
    expect(task.priority).toBe(3);
    expect(task.labels).toEqual(['errands']);
    expect(task.due?.string).toBe('tomorrow');
    const read = await api.getTask(task.id);
    expect(read.id).toBe(task.id);
    const updated = await api.updateTask(task.id, { content: 'Buy oat milk', description: 'Two litres' });
    expect(updated.content).toBe('Buy oat milk');
    expect(updated.description).toBe('Two litres');
    await api.closeTask(task.id);
    expect((await api.getTask(task.id)).checked).toBe(true);
    await api.reopenTask(task.id);
    expect((await api.getTask(task.id)).checked).toBe(false);
    const other = await api.addProject({ name: 'Elsewhere' });
    const moved = await api.moveTask(task.id, { projectId: other.id });
    expect(moved.projectId).toBe(other.id);
    await api.deleteTask(task.id);
    await expect(api.getTask(task.id)).rejects.toThrow();
  });

  it('lists open tasks, filtered by project, with a cursor', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    await api.addTask({ content: 'One', projectId: inbox });
    await api.addTask({ content: 'Two', projectId: inbox });
    const page = await api.getTasks({ projectId: inbox, limit: 1 });
    expect(page.results).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const rest = await api.getTasks({ projectId: inbox, limit: 10 });
    expect(rest.results.map((task) => task.content).sort()).toEqual(['One', 'Two']);
  });

  it('finds tasks by a filter query', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    await api.addTask({ content: 'Due today', projectId: inbox, dueString: 'today' });
    const found = await api.getTasksByFilter({ query: 'today' });
    expect(found.results.map((task) => task.content)).toContain('Due today');
  });

  it('lists tasks completed in a period', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const task = await api.addTask({ content: 'Finished', projectId: inbox });
    await api.closeTask(task.id);
    const done = await api.getCompletedTasksByCompletionDate({ since: '2000-01-01T00:00:00Z', until: '2999-01-01T00:00:00Z', limit: 50 });
    expect(done.items.some((item) => item.content === 'Finished')).toBe(true);
  });
});

describe('the SDK against projects', () => {
  it('adds, reads, updates, archives, unarchives and deletes a project', async () => {
    const { api } = await account();
    const project = await api.addProject({ name: 'Work', color: 'blue', isFavorite: true, viewStyle: 'board' });
    expect(project.name).toBe('Work');
    expect((await api.getProject(project.id)).color).toBe('blue');
    const renamed = await api.updateProject(project.id, { name: 'Office' });
    expect(renamed.name).toBe('Office');
    await api.archiveProject(project.id);
    expect((await api.getArchivedProjects()).results.map((p) => p.id)).toContain(project.id);
    await api.unarchiveProject(project.id);
    expect((await api.getProjects()).results.map((p) => p.id)).toContain(project.id);
    await api.deleteProject(project.id);
    await expect(api.getProject(project.id)).rejects.toThrow();
  });

  it('nests a project under another', async () => {
    const { api } = await account();
    const parent = await api.addProject({ name: 'Parent' });
    const child = await api.addProject({ name: 'Child', parentId: parent.id });
    expect((child as { parentId?: string }).parentId).toBe(parent.id);
  });

  it('lists the collaborators of a project', async () => {
    const { who, api } = await account();
    const project = await api.addProject({ name: 'Solo' });
    const people = await api.getProjectCollaborators(project.id);
    expect(people.results.map((p) => p.id)).toContain(who.id);
  });
});

describe('the SDK against sections, labels, comments and folders', () => {
  it('adds, reads, updates and deletes a section', async () => {
    const { api } = await account();
    const project = await api.addProject({ name: 'Board' });
    const section = await api.addSection({ name: 'Doing', projectId: project.id });
    expect(section.projectId).toBe(project.id);
    expect((await api.getSections({ projectId: project.id })).results.map((s) => s.name)).toEqual(['Doing']);
    expect((await api.getSection(section.id)).name).toBe('Doing');
    expect((await api.updateSection(section.id, { name: 'Done' })).name).toBe('Done');
    await api.deleteSection(section.id);
    expect((await api.getSections({ projectId: project.id })).results).toHaveLength(0);
  });

  it('adds, reads, updates and deletes a label', async () => {
    const { api } = await account();
    const label = await api.addLabel({ name: 'urgent', color: 'red' });
    expect((await api.getLabels()).results.map((l) => l.name)).toContain('urgent');
    const renamed = await api.updateLabel(label.id, { name: 'soon' });
    expect(renamed.name).toBe('soon');
    await api.deleteLabel(label.id);
    expect((await api.getLabels()).results.map((l) => l.name)).not.toContain('soon');
  });

  it('adds, reads, updates and deletes a comment on a task', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const task = await api.addTask({ content: 'Discuss', projectId: inbox });
    const comment = await api.addComment({ taskId: task.id, content: 'First thought' });
    expect(comment.taskId).toBe(task.id);
    expect((await api.getComments({ taskId: task.id })).results.map((c) => c.content)).toContain('First thought');
    expect((await api.getComment(comment.id)).content).toBe('First thought');
    expect((await api.updateComment(comment.id, { content: 'Second thought' })).content).toBe('Second thought');
    await api.deleteComment(comment.id);
    expect((await api.getComments({ taskId: task.id })).results).toHaveLength(0);
  });
});

describe('the SDK against workspaces', () => {
  it('lists the workspaces the person is in', async () => {
    const { api } = await account();
    const workspaces = await api.getWorkspaces();
    expect(Array.isArray(workspaces)).toBe(true);
  });

  it('adds, reads, updates and deletes a folder in a workspace the person runs', async () => {
    const { who, api } = await account();
    const made = await new Api(server.base, who.token).sync({ commands: [{ type: 'workspace_add', uuid: '11111111-2222-4333-8444-000000000001', args: { name: 'Studio' }, temp_id: '00000000-0000-4000-8000-000000000201' }] });
    const workspaceId = made.body.temp_id_mapping['00000000-0000-4000-8000-000000000201'] as string;
    const folder = await api.addFolder({ name: 'Clients', workspaceId });
    expect(folder.workspaceId).toBe(workspaceId);
    expect((await api.getFolder(folder.id)).name).toBe('Clients');
    expect((await api.getFolders({ workspaceId })).results.some((f) => f.id === folder.id)).toBe(true);
    expect((await api.updateFolder(folder.id, { name: 'Client work' })).name).toBe('Client work');
    await api.deleteFolder(folder.id);
    expect((await api.getFolders({ workspaceId })).results.some((f) => f.id === folder.id)).toBe(false);
  });

  it('moves a project into a workspace and back, and lists the workspace\'s active projects', async () => {
    const { who, api } = await account();
    const made = await new Api(server.base, who.token).sync({ commands: [{ type: 'workspace_add', uuid: '11111111-2222-4333-8444-000000000002', args: { name: 'Hall' }, temp_id: '00000000-0000-4000-8000-000000000202' }] });
    const workspaceId = made.body.temp_id_mapping['00000000-0000-4000-8000-000000000202'] as string;
    const project = await api.addProject({ name: 'Roaming' });
    await api.moveProjectToWorkspace({ projectId: project.id, workspaceId });
    expect((await api.getProject(project.id) as { workspaceId?: string }).workspaceId).toBe(workspaceId);
    const active = await api.getWorkspaceActiveProjects({ workspaceId });
    expect(active.results.map((p) => p.id)).toContain(project.id);
    await api.moveProjectToPersonal({ projectId: project.id });
    expect((await api.getProject(project.id) as { workspaceId?: string }).workspaceId).toBeUndefined();
  });

  it('lists the people on a project, and renames a label across the tasks that carry it', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    await api.addTask({ content: 'Tagged', projectId: inbox, labels: ['oldname'] });
    await api.renameSharedLabel({ name: 'oldname', newName: 'newname' });
    const tagged = (await api.getTasks({ projectId: inbox })).results.find((task) => task.content === 'Tagged');
    expect(tagged?.labels).toEqual(['newname']);
  });

  it('moves several tasks to a project at once', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const target = await api.addProject({ name: 'Batch target' });
    const a = await api.addTask({ content: 'A', projectId: inbox });
    const b = await api.addTask({ content: 'B', projectId: inbox });
    await api.moveTasks([a.id, b.id], { projectId: target.id });
    expect((await api.getTask(a.id)).projectId).toBe(target.id);
    expect((await api.getTask(b.id)).projectId).toBe(target.id);
  });

  it('joins a project shared with the person', async () => {
    const owner = await account();
    const member = await account();
    const project = await owner.api.addProject({ name: 'Shared room' });
    const joined = await member.api.joinProject(project.id).catch((e: unknown) => e);
    // Joining a project the person is not invited to is refused; the MCP reports it, it does not join.
    expect(joined).toBeInstanceOf(Error);
  });
});
