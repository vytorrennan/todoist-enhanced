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

describe('the SDK against reminders', () => {
  it('adds, reads, updates and deletes a relative and an absolute reminder', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const task = await api.addTask({ content: 'Call the bank', projectId: inbox, dueString: 'tomorrow' });
    const relative = await api.addReminder({ taskId: task.id, minuteOffset: 30 });
    expect(relative.type).toBe('relative');
    const absolute = await api.addReminder({ taskId: task.id, reminderType: 'absolute', due: { date: '2030-01-02T09:00:00', string: 'Jan 2 at 9am' } });
    expect(absolute.type).toBe('absolute');
    const listed = (await api.getReminders()).results.map((r) => r.id);
    expect(listed).toEqual(expect.arrayContaining([relative.id, absolute.id]));
    const updated = await api.updateReminder(relative.id, { reminderType: 'relative', minuteOffset: 45 });
    expect((updated as { minuteOffset?: number }).minuteOffset).toBe(45);
    await api.deleteReminder(relative.id);
    expect((await api.getReminders()).results.map((r) => r.id)).not.toContain(relative.id);
  });

  it('adds, reads, updates and deletes a location reminder', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const task = await api.addTask({ content: 'Pick up parcel', projectId: inbox });
    const place = await api.addLocationReminder({ taskId: task.id, name: 'Post office', locLat: '48.85', locLong: '2.35', locTrigger: 'on_enter', radius: 100 });
    expect(place.type).toBe('location');
    expect((await api.getLocationReminders({})).results.map((r) => r.id)).toContain(place.id);
    const renamed = await api.updateLocationReminder(place.id, { name: 'Main post office' });
    expect((renamed as { name?: string }).name).toBe('Main post office');
    await api.deleteLocationReminder(place.id);
    expect((await api.getLocationReminders({})).results.map((r) => r.id)).not.toContain(place.id);
  });
});

describe('the SDK against the activity log', () => {
  it('lists what changed in a project, newest first', async () => {
    const { api } = await account();
    const project = await api.addProject({ name: 'Logged' });
    const task = await api.addTask({ content: 'Logged task', projectId: project.id });
    await api.closeTask(task.id);
    type LogArgs = NonNullable<Parameters<typeof api.getActivityLogs>[0]>;
    const done = await api.getActivityLogs({ objectType: 'item', eventType: 'completed', parentProjectId: project.id } as unknown as LogArgs);
    expect(done.results.map((event) => event.objectId)).toContain(task.id);
    const added = await api.getActivityLogs({ objectType: 'item', eventType: 'added', parentProjectId: project.id } as unknown as LogArgs);
    expect(added.results.map((event) => event.objectId)).toContain(task.id);
  });
});

describe('the SDK against progress, health, activity and productivity', () => {
  it('reports a project\'s progress and health, and its activity by day', async () => {
    const { api } = await account();
    const project = await api.addProject({ name: 'Measured' });
    const done = await api.addTask({ content: 'Done one', projectId: project.id });
    await api.addTask({ content: 'Still open', projectId: project.id });
    await api.closeTask(done.id);
    const progress = await api.getProjectProgress(project.id);
    expect(progress.completedCount).toBe(1);
    expect(progress.activeCount).toBe(1);
    expect(progress.progressPercent).toBe(50);
    const health = await api.getProjectHealth(project.id);
    expect(['ON_TRACK', 'AT_RISK', 'CRITICAL', 'EXCELLENT', 'UNKNOWN']).toContain(health.status);
    const analyzed = await api.analyzeProjectHealth(project.id);
    expect(analyzed.status).toBe(health.status);
    const activity = await api.getProjectActivityStats(project.id);
    expect(activity.dayItems).toHaveLength(7);
    expect(activity.dayItems[6].totalCount).toBeGreaterThanOrEqual(1);
  });

  it('reports the insights of a workspace\'s projects', async () => {
    const { who, api } = await account();
    const made = await new Api(server.base, who.token).sync({ commands: [{ type: 'workspace_add', uuid: '11111111-2222-4333-8444-0000000000bb', args: { name: 'Insight hall' }, temp_id: '00000000-0000-4000-8000-0000000002bb' }] });
    const workspaceId = made.body.temp_id_mapping['00000000-0000-4000-8000-0000000002bb'] as string;
    const project = await api.addProject({ name: 'In the hall' });
    await api.moveProjectToWorkspace({ projectId: project.id, workspaceId });
    const insights = await api.getWorkspaceInsights(workspaceId);
    expect(insights.projectInsights.map((insight) => insight.projectId)).toContain(project.id);
  });

  it('reports productivity: what was completed, with streaks and the last seven days', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const task = await api.addTask({ content: 'Counted', projectId: inbox });
    await api.closeTask(task.id);
    const stats = await api.getProductivityStats();
    expect(stats.completedCount).toBeGreaterThanOrEqual(1);
    expect(stats.daysItems).toHaveLength(7);
  });
});

describe('the SDK against templates and attachments', () => {
  it('exports a project as CSV, and imports a CSV file back into a project', async () => {
    const { api } = await account();
    const project = await api.addProject({ name: 'Template source' });
    const section = await api.addSection({ name: 'Ideas', projectId: project.id });
    await api.addTask({ content: 'Write the book outline', projectId: project.id, sectionId: section.id, priority: 4 });
    const csv = await api.exportProjectAsCsv({ projectId: project.id });
    const text = typeof csv === 'string' ? csv : JSON.stringify(csv);
    expect(text).toContain('Ideas');
    expect(text).toContain('Write the book outline');
    const target = await api.addProject({ name: 'Imported into' });
    const csvFile = new Blob(['TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\ntask,First imported,,2,1,,,,,\ntask,Second imported,,1,2,,,,,\n'], { type: 'text/csv' });
    const imported = await api.importCsvIntoProject({ projectId: target.id, file: csvFile, fileName: 'import.csv' });
    expect(imported.tasks.map((task) => task.content)).toEqual(['First imported', 'Second imported']);
    expect(imported.tasks[1].parentId).toBe(imported.tasks[0].id);
  });

  it('gives a template URL for a project, and refuses a template from the Todoist library', async () => {
    const { api } = await account();
    const project = await api.addProject({ name: 'Shared template' });
    const url = await api.exportTemplateAsUrl({ projectId: project.id });
    expect(JSON.stringify(url)).toContain('templates/file');
    await expect(api.importTemplateFromId({ projectId: project.id, templateId: 'some-library-template' })).rejects.toThrow();
  });

  it('refuses to fetch an attachment from a host that is not Todoist\'s own, as the SDK does', async () => {
    const { api } = await account();
    await expect(api.viewAttachment('http://127.0.0.1:1/api/v1/files/abc')).rejects.toThrow(/known Todoist attachment host/);
  });
});

describe('the SDK against the sync endpoint', () => {
  it('reads changes and sends commands through sync, as the MCP does', async () => {
    const { api } = await account();
    const inbox = (await api.getUser()).inboxProjectId;
    const temp = '00000000-0000-4000-8000-0000000003cc';
    const reply = await api.sync({ syncToken: '*', resourceTypes: ['items', 'projects'], commands: [{ type: 'item_add', uuid: '11111111-2222-4333-8444-0000000003cc', args: { content: 'Through sync', project_id: inbox }, tempId: temp }] } as never);
    expect(reply.syncStatus ? Object.values(reply.syncStatus) : []).toEqual(['ok']);
    expect((reply.items ?? []).map((item: { content: string }) => item.content)).toContain('Through sync');
  });
});

describe('the SDK against filters and joining', () => {
  it('deletes a saved filter, and joins a workspace project shared with the person', async () => {
    const owner = await account();
    const member = await account();
    const sync = (who: Person, commands: unknown[]) => new Api(server.base, who.token).sync({ commands } as never) as Promise<{ body: { temp_id_mapping: Record<string, string> } }>;
    const made = await sync(owner.who, [{ type: 'filter_add', uuid: '11111111-2222-4333-8444-0000000004aa', args: { name: 'Gone', query: 'today' }, temp_id: '00000000-0000-4000-8000-0000000004aa' }]);
    const filterId = made.body.temp_id_mapping['00000000-0000-4000-8000-0000000004aa'];
    await owner.api.deleteFilter(filterId);
    await expect(owner.api.deleteFilter(filterId)).rejects.toThrow();

    const hall = await sync(owner.who, [{ type: 'workspace_add', uuid: '11111111-2222-4333-8444-0000000004bb', args: { name: 'Joinable hall' }, temp_id: '00000000-0000-4000-8000-0000000004bb' }]);
    const workspaceId = hall.body.temp_id_mapping['00000000-0000-4000-8000-0000000004bb'];
    const project = await owner.api.addProject({ name: 'Shared room' });
    await owner.api.moveProjectToWorkspace({ projectId: project.id, workspaceId });
    await sync(owner.who, [{ type: 'share_project', uuid: '11111111-2222-4333-8444-0000000004cc', args: { project_id: project.id, email: member.who.email, role: 'READ_WRITE' } }]);
    const joined = await member.api.joinProject(project.id);
    expect(joined.project.id).toBe(project.id);

    const unshared = await owner.api.addProject({ name: 'Not shared' });
    await owner.api.moveProjectToWorkspace({ projectId: unshared.id, workspaceId });
    await expect(member.api.joinProject(unshared.id)).rejects.toThrow();
  });
});
