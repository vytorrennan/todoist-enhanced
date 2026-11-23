import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, command, person, startServer, type TestServer, tempId, type Person } from './harness';

let server: TestServer;
let base: Api;
beforeAll(async () => { server = await startServer(); base = new Api(server.base); });
afterAll(async () => server.close());

const as = (who: Person) => new Api(server.base, who.token);
async function run(who: Person, commands: unknown[]) {
  const reply = await as(who).sync({ commands });
  return { reply, real: (n: number) => reply.body.temp_id_mapping[tempId(n)] as string, statuses: Object.values(reply.body.sync_status) as unknown[] };
}
async function invitesFor(who: Person) {
  const reply = await as(who).sync({ types: ['live_notifications'] });
  return (reply.body.live_notifications as Array<Record<string, any>>).filter((n) => n.notification_type === 'share_invitation_sent' && !n.answered);
}
async function accept(who: Person, note: Record<string, any>, yes = true) {
  return as(who).sync({ commands: [command(yes ? 'accept_invitation' : 'reject_invitation', { invitation_id: note.invitation_id, invitation_secret: note.invitation_secret })] });
}
async function projectOf(owner: Person, name: string) {
  const { real } = await run(owner, [command('project_add', { name }, { temp_id: tempId(1) })]);
  return real(1);
}

describe('projects', () => {
  it('creates a project in the sidebar and renames, recolours and favourites it', async () => {
    const who = await person(base);
    const id = await projectOf(who, 'Work');
    await run(who, [command('project_update', { id, name: 'Work 2', color: 'blue', is_favorite: true, description: 'Notes' })]);
    const mine = (await as(who).sync({})).body.projects.find((p: { id: string }) => p.id === id);
    expect(mine).toMatchObject({ name: 'Work 2', color: 'blue', is_favorite: true, description: 'Notes', role: 'CREATOR' });
  });

  it('refuses a colour the app does not know and a blank name', async () => {
    const who = await person(base);
    const { statuses } = await run(who, [command('project_add', { name: 'x', color: 'rainbow-unicorn!' }), command('project_add', { name: '  ' })]);
    expect(statuses).toEqual([expect.objectContaining({ error_tag: 'INVALID_COLOR' }), expect.objectContaining({ error_tag: 'INVALID_ARGUMENT' })]);
  });

  it('nests a project, refuses a cycle, and archives the whole branch', async () => {
    const who = await person(base);
    const { real, statuses } = await run(who, [
      command('project_add', { name: 'Parent' }, { temp_id: tempId(10) }),
      command('project_add', { name: 'Child', parent_id: tempId(10) }, { temp_id: tempId(11) }),
    ]);
    expect(statuses).toEqual(['ok', 'ok']);
    const cycle = await run(who, [command('project_move', { id: real(10), parent_id: real(11) })]);
    expect(cycle.statuses[0]).toMatchObject({ error_tag: 'CYCLE' });
    await run(who, [command('project_archive', { id: real(10) })]);
    const archive = await as(who).get('/api/v1/projects/archived');
    expect(archive.body.results.map((p: { id: string }) => p.id).sort()).toEqual([real(10), real(11)].sort());
    const projects = (await as(who).sync({})).body.projects as Array<{ id: string; is_archived: boolean }>;
    expect(projects.filter((p) => [real(10), real(11)].includes(p.id)).every((p) => p.is_archived)).toBe(true);
  });

  it('will not archive or delete the inbox, and only the owner deletes a project', async () => {
    const who = await person(base);
    const { statuses } = await run(who, [command('project_archive', { id: who.inbox }), command('project_delete', { id: who.inbox })]);
    expect(statuses.map((s) => (s as { error_tag: string }).error_tag)).toEqual(['INBOX', 'INBOX']);
    const other = await person(base);
    const id = await projectOf(other, 'Theirs');
    await run(other, [command('share_project', { project_id: id, email: who.email, role: 'ADMIN' })]);
    const [invite] = await invitesFor(who);
    await accept(who, invite);
    const attempt = await run(who, [command('project_delete', { id })]);
    expect(attempt.statuses[0]).toMatchObject({ error_tag: 'PROJECT_ROLE_TOO_LOW' });
  });

  it('deleting a project removes its tasks and sections for everyone who had it', async () => {
    const who = await person(base);
    const id = await projectOf(who, 'Doomed');
    await run(who, [command('section_add', { name: 'S', project_id: id }, { temp_id: tempId(20) }), command('item_add', { content: 'Gone', project_id: id })]);
    await run(who, [command('project_delete', { id })]);
    const after = await as(who).sync({ token: '0' });
    expect(after.body.projects.find((p: { id: string }) => p.id === id)).toMatchObject({ is_deleted: true });
    expect(after.body.items.some((i: { project_id: string; is_deleted: boolean }) => i.project_id === id && i.is_deleted)).toBe(true);
    expect((await as(who).sync({})).body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
  });

  it('a project of someone else is not found by a stranger, and its reads are not shared', async () => {
    const owner = await person(base);
    const stranger = await person(base);
    const id = await projectOf(owner, 'Private');
    const reply = await as(stranger).get(`/api/v1/projects/${id}/full`);
    expect(reply.status).toBe(404);
    expect(reply.body.error_tag).toBe('PROJECT_NOT_FOUND');
    const seen = await as(stranger).sync({});
    expect(seen.body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
  });

  it('moves a project between parents only inside the same workspace, and not into a folder of another', async () => {
    const who = await person(base);
    const { real } = await run(who, [command('project_add', { name: 'A' }, { temp_id: tempId(30) }), command('project_add', { name: 'B' }, { temp_id: tempId(31) })]);
    const move = await run(who, [command('project_move', { id: real(31), parent_id: real(30) })]);
    expect(move.statuses[0]).toBe('ok');
    const moved = (await as(who).sync({})).body.projects.find((p: { id: string }) => p.id === real(31));
    expect(moved.parent_id).toBe(real(30));
  });
});

describe('sections', () => {
  it('adds sections in order, renames, archives and unarchives them', async () => {
    const who = await person(base);
    const id = await projectOf(who, 'Board');
    const { real } = await run(who, [command('section_add', { name: 'Todo', project_id: id }, { temp_id: tempId(40) }), command('section_add', { name: 'Doing', project_id: id }, { temp_id: tempId(41) })]);
    await run(who, [command('section_update', { id: real(40), name: 'To do' }), command('section_archive', { id: real(41) })]);
    let sections = (await as(who).sync({})).body.sections;
    expect(sections.find((s: { id: string }) => s.id === real(40))).toMatchObject({ name: 'To do', is_archived: false });
    expect(sections.find((s: { id: string }) => s.id === real(41))).toMatchObject({ is_archived: true });
    await run(who, [command('section_unarchive', { id: real(41) })]);
    sections = (await as(who).sync({})).body.sections;
    expect(sections.find((s: { id: string }) => s.id === real(41))).toMatchObject({ is_archived: false });
  });

  it('deleting a section keeps its tasks in the project, at the top level', async () => {
    const who = await person(base);
    const id = await projectOf(who, 'Sections');
    const { real } = await run(who, [command('section_add', { name: 'Go', project_id: id }, { temp_id: tempId(42) }), command('item_add', { content: 'Stays', project_id: id, section_id: tempId(42) }, { temp_id: tempId(43) })]);
    await run(who, [command('section_delete', { id: real(42) })]);
    const items = (await as(who).sync({})).body.items;
    expect(items.find((i: { id: string }) => i.id === real(43))).toMatchObject({ section_id: null, project_id: id });
  });

  it('moving a section moves its tasks with it, and a task cannot name a section of another project', async () => {
    const who = await person(base);
    const from = await projectOf(who, 'From');
    const setup = await run(who, [command('project_add', { name: 'To' }, { temp_id: tempId(44) }), command('section_add', { name: 'S', project_id: from }, { temp_id: tempId(45) })]);
    const task = await run(who, [command('item_add', { content: 'Inside', project_id: from, section_id: setup.real(45) }, { temp_id: tempId(46) })]);
    await run(who, [command('section_move', { id: setup.real(45), project_id: setup.real(44) })]);
    const items = (await as(who).sync({})).body.items;
    expect(items.find((i: { id: string }) => i.id === task.real(46))?.project_id).toBe(setup.real(44));
    const bad = await run(who, [command('item_add', { content: 'Wrong', project_id: from, section_id: setup.real(45) })]);
    expect(bad.statuses[0]).toMatchObject({ error_tag: 'SECTION_NOT_IN_PROJECT' });
  });
});

describe('sharing', () => {
  it('invites a person, who sees the project only after accepting', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const id = await projectOf(owner, 'Team');
    await run(owner, [command('share_project', { project_id: id, email: guest.email, role: 'READ_WRITE' })]);
    expect((await as(guest).sync({})).body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
    const [invite] = await invitesFor(guest);
    expect(invite).toMatchObject({ from_uid: owner.id, project_id: id });
    const answered = await accept(guest, invite);
    expect(answered.body.sync_status[Object.keys(answered.body.sync_status)[0]]).toBe('ok');
    const seen = await as(guest).sync({});
    expect(seen.body.full_sync).toBe(true);
    expect(seen.body.projects.find((p: { id: string }) => p.id === id)).toMatchObject({ role: 'READ_WRITE', is_shared: true });
    const states = (await as(owner).sync({})).body.collaborator_states;
    expect(states.find((s: { user_id: string }) => s.user_id === guest.id)).toMatchObject({ state: 'active', role: 'READ_WRITE' });
  });

  it('the owner hears that the invitation was accepted, and the invitation reads as answered', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const id = await projectOf(owner, 'Answered');
    await run(owner, [command('share_project', { project_id: id, email: guest.email })]);
    const [invite] = await invitesFor(guest);
    await accept(guest, invite);
    const ownerNotes = (await as(owner).sync({ types: ['live_notifications'] })).body.live_notifications;
    expect(ownerNotes.map((n: { notification_type: string }) => n.notification_type)).toContain('share_invitation_accepted');
    const guestNotes = (await as(guest).sync({ types: ['live_notifications'] })).body.live_notifications;
    expect(guestNotes.find((n: { notification_type: string }) => n.notification_type === 'share_invitation_sent')).toMatchObject({ state: 'accepted' });
  });

  it('a declined invitation gives no access, and the owner hears of it', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const id = await projectOf(owner, 'No thanks');
    await run(owner, [command('share_project', { project_id: id, email: guest.email })]);
    const [invite] = await invitesFor(guest);
    await accept(guest, invite, false);
    expect((await as(guest).sync({})).body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
    const ownerNotes = (await as(owner).sync({ types: ['live_notifications'] })).body.live_notifications;
    expect(ownerNotes.map((n: { notification_type: string }) => n.notification_type)).toContain('share_invitation_rejected');
  });

  it('an invitation can only be answered by the person it was sent to, with its secret', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const other = await person(base);
    const id = await projectOf(owner, 'Mine');
    await run(owner, [command('share_project', { project_id: id, email: guest.email })]);
    const [invite] = await invitesFor(guest);
    const byOther = await accept(other, invite);
    expect(Object.values(byOther.body.sync_status)[0]).toMatchObject({ error_tag: 'INVITATION_NOT_FOUND' });
    const badSecret = await as(guest).sync({ commands: [command('accept_invitation', { invitation_id: invite.invitation_id, invitation_secret: 'wrong' })] });
    expect(Object.values(badSecret.body.sync_status)[0]).toMatchObject({ error_tag: 'INVITATION_NOT_FOUND' });
  });

  it('accepting twice is harmless; changing the answer afterwards is refused', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const id = await projectOf(owner, 'Twice');
    await run(owner, [command('share_project', { project_id: id, email: guest.email })]);
    const [invite] = await invitesFor(guest);
    await accept(guest, invite);
    const again = await accept(guest, invite);
    expect(Object.values(again.body.sync_status)[0]).toBe('ok');
    const reject = await accept(guest, invite, false);
    expect(Object.values(reject.body.sync_status)[0]).toMatchObject({ error_tag: 'INVITATION_ANSWERED' });
  });

  it('inviting someone already in the project changes their role instead of inviting them again', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const id = await projectOf(owner, 'Roles');
    await run(owner, [command('share_project', { project_id: id, email: guest.email, role: 'READ_ONLY' })]);
    const [invite] = await invitesFor(guest);
    await accept(guest, invite);
    await run(owner, [command('share_project', { project_id: id, email: guest.email, role: 'ADMIN' })]);
    const states = (await as(owner).sync({})).body.collaborator_states.filter((s: { user_id: string }) => s.user_id === guest.id);
    expect(states).toEqual([expect.objectContaining({ state: 'active', role: 'ADMIN' })]);
  });

  it('a read-only member cannot change anything', async () => {
    const owner = await person(base);
    const reader = await person(base);
    const id = await projectOf(owner, 'Look');
    await run(owner, [command('item_add', { content: 'Seen', project_id: id }, { temp_id: tempId(2) })]);
    await run(owner, [command('share_project', { project_id: id, email: reader.email, role: 'READ_ONLY' })]);
    await accept(reader, (await invitesFor(reader))[0]);
    const attempt = await run(reader, [command('item_add', { content: 'Mine', project_id: id }), command('project_update', { id, name: 'Renamed' })]);
    expect(attempt.statuses.map((s) => (s as { error_tag: string }).error_tag)).toEqual(['PROJECT_ROLE_TOO_LOW', 'PROJECT_ROLE_TOO_LOW']);
    expect((await as(reader).sync({})).body.items.map((i: { content: string }) => i.content)).toEqual(['Seen']);
  });

  it('only an admin shares, and the owner’s own role cannot be changed', async () => {
    const owner = await person(base);
    const member = await person(base);
    const id = await projectOf(owner, 'Admins');
    await run(owner, [command('share_project', { project_id: id, email: member.email, role: 'READ_WRITE' })]);
    await accept(member, (await invitesFor(member))[0]);
    const share = await run(member, [command('share_project', { project_id: id, email: 'someone@example.com' })]);
    expect(share.statuses[0]).toMatchObject({ error_tag: 'PROJECT_ROLE_TOO_LOW' });
    const change = await run(owner, [command('project_change_role', { id, user_id: owner.id, role: 'READ_ONLY' })]);
    expect(change.statuses[0]).toMatchObject({ error_tag: 'OWNER_ROLE' });
    const promote = await run(owner, [command('project_change_role', { id, user_id: member.id, role: 'CREATOR' })]);
    expect(promote.statuses[0]).toMatchObject({ error_tag: 'INVALID_ROLE' });
  });

  it('removing a member takes the project away from them on their next sync, and they hear why', async () => {
    const owner = await person(base);
    const member = await person(base);
    const id = await projectOf(owner, 'Removal');
    await run(owner, [command('item_add', { content: 'Shared task', project_id: id })]);
    await run(owner, [command('share_project', { project_id: id, email: member.email })]);
    await accept(member, (await invitesFor(member))[0]);
    expect((await as(member).sync({})).body.items.length).toBe(1);
    await run(owner, [command('delete_collaborator', { project_id: id, email: member.email })]);
    const after = await as(member).sync({ token: '0' });
    expect(after.body.full_sync).toBe(true);
    expect(after.body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
    expect(after.body.items.some((i: { content: string }) => i.content === 'Shared task')).toBe(false);
    const notes = (await as(member).sync({ types: ['live_notifications'] })).body.live_notifications;
    expect(notes.map((n: { notification_type: string }) => n.notification_type)).toContain('user_removed_from_project');
    const ownerView = await as(owner).sync({ token: '0' });
    expect(ownerView.body.collaborator_states.find((s: { user_id: string }) => s.user_id === member.id)).toMatchObject({ is_deleted: true });
  });

  it('a member can leave a project themselves, but the owner cannot be removed', async () => {
    const owner = await person(base);
    const member = await person(base);
    const id = await projectOf(owner, 'Leave');
    await run(owner, [command('share_project', { project_id: id, email: member.email })]);
    await accept(member, (await invitesFor(member))[0]);
    const leave = await as(member).sync({ commands: [command('delete_collaborator', { project_id: id, email: member.email })] });
    expect(Object.values(leave.body.sync_status)[0]).toBe('ok');
    expect((await as(member).sync({})).body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
    const owned = await run(owner, [command('delete_collaborator', { project_id: id, email: owner.email })]);
    expect(owned.statuses[0]).toMatchObject({ error_tag: 'OWNER_REMOVAL' });
  });

  it('an invitation needs an account at that address: nobody can be invited into a place the address has not claimed', async () => {
    const owner = await person(base);
    const id = await projectOf(owner, 'Waiting');
    const future = `later-${Math.random().toString(36).slice(2)}@example.com`;
    const refused = await run(owner, [command('share_project', { project_id: id, email: future })]);
    expect(refused.statuses[0]).toMatchObject({ error_tag: 'NOT_REGISTERED' });
    // Signing up with that address afterwards gets nothing from the earlier attempt.
    const reply = await base.call('POST', '/api/v1/auth/register', { email: future, password: 'a long password', full_name: 'Later' });
    const newcomer = { email: future, token: reply.body.token, id: reply.body.user.id, inbox: reply.body.user.inbox_project_id } as Person;
    expect(await invitesFor(newcomer)).toEqual([]);
    expect((await as(newcomer).sync({})).body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
  });

  it('withdraws an invitation the owner takes back', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const id = await projectOf(owner, 'Take back');
    await run(owner, [command('share_project', { project_id: id, email: guest.email })]);
    const [invite] = await invitesFor(guest);
    await run(owner, [command('delete_collaborator', { project_id: id, email: guest.email })]);
    const answer = await accept(guest, invite);
    expect(Object.values(answer.body.sync_status)[0]).toMatchObject({ error_tag: 'INVITATION_NOT_FOUND' });
  });

  it('refuses to invite yourself, and an unknown role', async () => {
    const owner = await person(base);
    const id = await projectOf(owner, 'Self');
    const self = await run(owner, [command('share_project', { project_id: id, email: owner.email })]);
    expect(self.statuses[0]).toMatchObject({ error_tag: 'ALREADY_MEMBER' });
    const role = await run(owner, [command('share_project', { project_id: id, email: 'x@example.com', role: 'SUPERUSER' })]);
    expect(role.statuses[0]).toMatchObject({ error_tag: 'INVALID_ROLE' });
  });

  it('a guest of a workspace is not in its projects until shared with them', async () => {
    const admin = await person(base);
    const guest = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Team' }, { temp_id: tempId(60) })]);
    const ws = real(60);
    await run(admin, [command('workspace_invite', { workspace_id: ws, email: guest.email, role: 'GUEST' })]);
    const [note] = (await as(guest).sync({ types: ['live_notifications'] })).body.live_notifications.filter((n: { notification_type: string }) => n.notification_type === 'workspace_invitation_created');
    await as(guest).sync({ commands: [command('accept_invitation', { invitation_id: note.invitation_id, invitation_secret: note.invitation_secret })] });
    const project = await run(admin, [command('project_add', { name: 'Inside', workspace_id: ws }, { temp_id: tempId(61) })]);
    expect(project.statuses[0]).toBe('ok');
    expect((await as(guest).sync({})).body.projects.some((p: { workspace_id: string | null }) => p.workspace_id === ws)).toBe(false);
    const guestAdd = await run(guest, [command('project_add', { name: 'Mine', workspace_id: ws })]);
    expect(guestAdd.statuses[0]).toMatchObject({ error_tag: 'WORKSPACE_ROLE_TOO_LOW' });
  });
});

describe('workspaces', () => {
  it('a member joins every project of the workspace; the list of members shows roles', async () => {
    const admin = await person(base);
    const member = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Studio' }, { temp_id: tempId(70) })]);
    const ws = real(70);
    await run(admin, [command('project_add', { name: 'Site', workspace_id: ws }, { temp_id: tempId(71) })]);
    await run(admin, [command('workspace_invite', { workspace_id: ws, email: member.email })]);
    const [note] = (await as(member).sync({ types: ['live_notifications'] })).body.live_notifications.filter((n: { notification_type: string }) => n.notification_type === 'workspace_invitation_created');
    await as(member).sync({ commands: [command('accept_invitation', { invitation_id: note.invitation_id, invitation_secret: note.invitation_secret })] });
    const seen = await as(member).sync({});
    expect(seen.body.projects.filter((p: { workspace_id: string | null }) => p.workspace_id === ws)).toHaveLength(1);
    const users = await as(member).get(`/api/v1/workspaces/users?workspace_id=${ws}`);
    expect(users.body.workspace_users.map((u: { role: string }) => u.role).sort()).toEqual(['ADMIN', 'MEMBER']);
    const folders = await as(member).get(`/api/v1/folders?workspace_id=${ws}`);
    expect(folders.body.results).toEqual([]);
    const stranger = await person(base);
    expect((await as(stranger).get(`/api/v1/workspaces/users?workspace_id=${ws}`)).status).toBe(404);
  });

  it('folders group a workspace’s projects, and deleting one keeps its projects', async () => {
    const admin = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Folders' }, { temp_id: tempId(80) })]);
    const ws = real(80);
    const made = await run(admin, [command('folder_add', { workspace_id: ws, name: 'Clients' }, { temp_id: tempId(81) })]);
    expect(made.statuses[0]).toBe('ok');
    const folder = real(81);
    await run(admin, [command('project_add', { name: 'Acme', workspace_id: ws, folder_id: folder }, { temp_id: tempId(82) })]);
    const list = await as(admin).get(`/api/v1/folders?workspace_id=${ws}`);
    expect(list.body.results.map((f: { name: string }) => f.name)).toEqual(['Clients']);
    await run(admin, [command('folder_delete', { id: folder, workspace_id: ws })]);
    const project = (await as(admin).sync({})).body.projects.find((p: { name: string }) => p.name === 'Acme');
    expect(project).toMatchObject({ folder_id: null, workspace_id: ws });
  });

  it('a project cannot be put in a folder of another workspace', async () => {
    const admin = await person(base);
    const one = await run(admin, [command('workspace_add', { name: 'One' }, { temp_id: tempId(90) })]);
    const two = await run(admin, [command('workspace_add', { name: 'Two' }, { temp_id: tempId(91) }), command('folder_add', { workspace_id: one.real(90), name: 'F' }, { temp_id: tempId(92) })]);
    expect(two.statuses[1]).toBe('ok');
    const bad = await run(admin, [command('project_add', { name: 'Stray', workspace_id: one.real(90), folder_id: one.real(92) })]);
    expect(bad.statuses[0]).toBe('ok');
    const wrong = await run(admin, [command('project_add', { name: 'Stray2', workspace_id: two.real(91), folder_id: two.real(92) })]);
    expect(wrong.statuses[0]).toMatchObject({ error_tag: 'FOLDER_NOT_IN_WORKSPACE' });
  });

  it('only a workspace admin changes its roles and membership, and the creator stays in', async () => {
    const admin = await person(base);
    const member = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Roles' }, { temp_id: tempId(93) })]);
    const ws = real(93);
    await run(admin, [command('workspace_invite', { workspace_id: ws, email: member.email })]);
    const [note] = (await as(member).sync({ types: ['live_notifications'] })).body.live_notifications.filter((n: { notification_type: string }) => n.notification_type === 'workspace_invitation_created');
    await as(member).sync({ commands: [command('accept_invitation', { invitation_id: note.invitation_id, invitation_secret: note.invitation_secret })] });
    const promote = await as(member).post(`/api/v1/workspaces/${ws}/users/${member.id}`, { role: 'ADMIN' });
    expect(promote.status).toBe(403);
    const ok = await as(admin).post(`/api/v1/workspaces/${ws}/users/${member.id}`, { role: 'ADMIN' });
    expect(ok.status).toBe(200);
    const leaveCreator = await run(admin, [command('workspace_remove_member', { workspace_id: ws, user_id: admin.id })]);
    expect(leaveCreator.statuses[0]).toMatchObject({ error_tag: 'OWNER_REMOVAL' });
  });
});
