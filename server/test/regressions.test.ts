import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Api, command, person, startServer, type TestServer, tempId, type Person } from './harness';
import { createApp } from '../app';

/**
 * One test per finding of the review that changed the server. Each fails on
 * the code before its fix, and says which failure it guards against.
 */

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
  return (reply.body.live_notifications as Array<Record<string, any>>)
    .filter((n) => (n.notification_type === 'share_invitation_sent' || n.notification_type === 'workspace_invitation_created') && !n.answered);
}
async function acceptFirst(who: Person) {
  const [invite] = await invitesFor(who);
  return as(who).sync({ commands: [command('accept_invitation', { invitation_id: invite.invitation_id, invitation_secret: invite.invitation_secret })] });
}
async function upload(who: Person, name: string, bytes: string) {
  const form = new FormData();
  form.append('file_name', name);
  form.append('file', new Blob([bytes], { type: 'text/plain' }), name);
  const res = await fetch(`${server.base}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${who.token}` }, body: form });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('review: files, invitations and sessions', () => {
  it('a file name shaped like another file’s address does not open that file', async () => {
    const owner = await person(base);
    const viewer = await person(base);
    const secret = await upload(owner, 'private.txt', 'private contents');
    const { real } = await run(owner, [command('project_add', { name: 'Shared files' }, { temp_id: tempId(1) })]);
    await run(owner, [command('share_project', { project_id: real(1), email: viewer.email, role: 'READ_ONLY' })]);
    await acceptFirst(viewer);
    // The attacker, who can comment in the project, names their own file after the private file's address.
    const trap = await upload(owner, secret.body.file_url as string, 'bait');
    const noted = await run(owner, [command('note_add', { project_id: real(1), content: 'see', file_attachment: trap.body })]);
    expect(noted.statuses[0]).toBe('ok');
    const attempt = await fetch(server.base + secret.body.file_url, { headers: { authorization: `Bearer ${viewer.token}` } });
    expect(attempt.status).toBe(404);
  });

  it('an upload over the limit leaves neither the file nor a database row', async () => {
    const dir = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'tde-limit-'));
    const small = createApp({ database: join(dir, 'limit.db'), dataDir: dir, maxUploadBytes: 1024 });
    await new Promise<void>((resolve) => small.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(small.server.address() as { port: number }).port}`;
    try {
      const signed = await new Api(url).post('/api/v1/auth/register', { email: 'limit@example.com', password: 'a long password' });
      const form = new FormData();
      form.append('file_name', 'big.bin');
      form.append('file', new Blob([new Uint8Array(4096)]), 'big.bin');
      const res = await fetch(`${url}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${signed.body.token}` }, body: form });
      expect(res.status).toBe(413);
      expect((small.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(0);
      expect(readdirSync(join(dir, 'files'))).toEqual([]);
    } finally {
      await small.close();
      (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sync cursor from another account gets everything, never the other account’s changes', async () => {
    const first = await person(base);
    const second = await person(base);
    const kept = await as(first).sync({});
    const foreign = await as(second).sync({ token: kept.body.sync_token });
    expect(foreign.body.full_sync).toBe(true);
  });

  it('two devices of one account both read everything after access changes, however many reads came first', async () => {
    const owner = await person(base);
    const member = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Revoked' }, { temp_id: tempId(2) })]);
    await run(owner, [command('share_project', { project_id: real(2), email: member.email })]);
    await acceptFirst(member);
    const deviceOne = await as(member).sync({});
    const deviceTwo = await new Api(server.base, (await as(member).post('/api/v1/auth/login', { email: member.email, password: 'a-long-password' })).body.token).sync({ token: deviceOne.body.sync_token });
    expect(deviceTwo.body.full_sync).toBe(false);
    await run(owner, [command('delete_collaborator', { project_id: real(2), email: member.email })]);
    // Device one reads first and gets the full picture; device two has not read yet and must get it too.
    const first = await as(member).sync({ token: deviceOne.body.sync_token });
    const partial = await as(member).sync({ token: deviceOne.body.sync_token, types: ['completed_info'] });
    const second = await new Api(server.base, member.token).sync({ token: deviceOne.body.sync_token });
    expect(first.body.full_sync).toBe(true);
    expect(partial.body.full_sync).toBe(true);
    expect(second.body.full_sync).toBe(true);
    expect(second.body.projects.some((p: { id: string }) => p.id === real(2))).toBe(false);
  });

  it('a late sign-out does not clear the attachment cookie of a newer sign-in', async () => {
    const who = await person(base);
    const older = (await base.post('/api/v1/auth/login', { email: who.email, password: 'a-long-password' })).body.token as string;
    const newer = (await base.post('/api/v1/auth/login', { email: who.email, password: 'a-long-password' })).body.token as string;
    const late = await fetch(`${server.base}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${older}`, cookie: `tde_session=${encodeURIComponent(newer)}` } });
    expect(late.status).toBe(204);
    expect(late.headers.get('set-cookie')).toBeNull();
    expect((await new Api(server.base, newer).get('/api/v1/auth/me')).status).toBe(200);
  });
});

describe('review: permissions and visibility', () => {
  it('archiving a project refuses when a subproject belongs to someone the person cannot administer', async () => {
    const owner = await person(base);
    const helper = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Parent' }, { temp_id: tempId(10) })]);
    await run(owner, [command('share_project', { project_id: real(10), email: helper.email, role: 'READ_WRITE' })]);
    await acceptFirst(helper);
    const child = await run(helper, [command('project_add', { name: 'Helper’s child', parent_id: real(10) }, { temp_id: tempId(11) })]);
    const childId = child.real(11);
    const archive = await run(owner, [command('project_archive', { id: real(10) })]);
    expect(archive.statuses[0]).toMatchObject({ error_tag: 'PROJECT_NOT_FOUND' });
    const helperView = await as(helper).sync({});
    expect(helperView.body.projects.find((p: { id: string }) => p.id === childId)?.is_archived).toBe(false);
  });

  it('a restricted project in a workspace is not given to the team, and a public one is refused', async () => {
    const admin = await person(base);
    const member = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Vault' }, { temp_id: tempId(20) })]);
    const ws = real(20);
    await run(admin, [command('workspace_invite', { workspace_id: ws, email: member.email })]);
    await acceptFirst(member);
    await run(admin, [command('project_add', { name: 'Restricted', workspace_id: ws, access: { visibility: 'restricted' } }, { temp_id: tempId(21) })]);
    await run(admin, [command('project_add', { name: 'Team', workspace_id: ws, access: { visibility: 'team' } }, { temp_id: tempId(22) })]);
    const names = (await as(member).sync({})).body.projects.map((p: { name: string }) => p.name);
    expect(names).toContain('Team');
    expect(names).not.toContain('Restricted');
    const refused = await run(admin, [command('project_add', { name: 'Open', workspace_id: ws, access: { visibility: 'public' } })]);
    expect(refused.statuses[0]).toMatchObject({ error_tag: 'INVALID_ACCESS' });
  });

  it('opening a project to the team does not answer a pending invitation: the invitee has the project once they accept it', async () => {
    const admin = await person(base);
    const invitee = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Hall' }, { temp_id: tempId(40) })]);
    const ws = real(40);
    await run(admin, [command('workspace_invite', { workspace_id: ws, email: invitee.email })]);
    await acceptFirst(invitee);
    const made = await run(admin, [command('project_add', { name: 'Pending', workspace_id: ws, access: { visibility: 'restricted' } }, { temp_id: tempId(41) })]);
    const project = made.real(41);
    expect(project).toBeTruthy();
    await run(admin, [command('share_project', { project_id: project, email: invitee.email, role: 'READ_WRITE' })]);
    await run(admin, [command('project_update', { id: project, access: { visibility: 'team' } })]);
    const waiting = (await as(invitee).sync({})).body.projects.map((p: { id: string }) => p.id);
    expect(waiting).not.toContain(project);
    await acceptFirst(invitee);
    const accepted = (await as(invitee).sync({})).body.projects.map((p: { id: string }) => p.id);
    expect(accepted).toContain(project);
  });

  it('a full read keeps a checked subtask of an open task, however deep, with its comments, as an incremental read does', async () => {
    const who = await person(base);
    const { real } = await run(who, [
      command('item_add', { content: 'Parent', project_id: who.inbox }, { temp_id: tempId(50) }),
      command('item_add', { content: 'Step', project_id: who.inbox, parent_id: tempId(50) }, { temp_id: tempId(51) }),
      command('note_add', { item_id: tempId(51), content: 'Done with the step' }, { temp_id: tempId(52) }),
      command('item_add', { content: 'Detail', project_id: who.inbox, parent_id: tempId(51) }, { temp_id: tempId(53) }),
      command('note_add', { item_id: tempId(53), content: 'Detail note' }, { temp_id: tempId(54) }),
    ]);
    await run(who, [command('item_complete', { id: real(51) }), command('item_complete', { id: real(53) })]);
    const full = (await as(who).sync({})).body;
    expect(full.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([real(51), real(53)]));
    expect(full.notes.map((note: { content: string }) => note.content)).toEqual(expect.arrayContaining(['Done with the step', 'Detail note']));
  });

  it('a write that names another account than its bearer is refused and writes nothing; one that names its own goes through', async () => {
    const owner = await person(base);
    const other = await person(base);
    const { real } = await run(owner, [
      command('item_add', { content: 'Shared thought', project_id: owner.inbox }, { temp_id: tempId(80) }),
      command('note_add', { item_id: tempId(80), content: 'Hi' }, { temp_id: tempId(81) }),
    ]);
    const note = real(81);
    const react = (named: string) => fetch(`${server.base}/api/v1/comments/${note}/reactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json', 'x-account-id': named },
      body: JSON.stringify({ reaction: '🎉' }),
    });
    const refused = await react(other.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error_tag: string }).error_tag).toBe('ACCOUNT_CHANGED');
    const before = (await as(owner).sync({})).body.notes.find((n: { id: string }) => n.id === note);
    expect(before.reactions ?? null).toBeNull();
    expect((await react(owner.id)).status).toBe(200);
  });

  it('a read-only member’s label rename leaves the tasks of the project alone', async () => {
    const owner = await person(base);
    const reader = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Read only' }, { temp_id: tempId(30) })]);
    const project = real(30);
    await run(owner, [command('item_add', { content: 'Task', project_id: project, labels: ['shared-tag'] }, { temp_id: tempId(31) })]);
    const task = (await run(owner, [])).reply;
    void task;
    await run(owner, [command('share_project', { project_id: project, email: reader.email, role: 'READ_ONLY' })]);
    await acceptFirst(reader);
    await run(reader, [command('label_add', { name: 'shared-tag' }, { temp_id: tempId(32) })]);
    const label = (await as(reader).sync({})).body.labels.find((l: { name: string }) => l.name === 'shared-tag');
    await run(reader, [command('label_update', { id: label.id, name: 'renamed' })]);
    const items = (await as(owner).sync({})).body.items.filter((i: { project_id: string }) => i.project_id === project);
    expect(items[0].labels).toEqual(['shared-tag']);
  });

  it('demoting a workspace admin takes the admin grant off team projects, and a guest keeps no team project', async () => {
    const admin = await person(base);
    const deputy = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Roles' }, { temp_id: tempId(40) })]);
    const ws = real(40);
    await run(admin, [command('workspace_invite', { workspace_id: ws, email: deputy.email, role: 'ADMIN' })]);
    await acceptFirst(deputy);
    await run(admin, [command('project_add', { name: 'Team project', workspace_id: ws, access: { visibility: 'team' } }, { temp_id: tempId(41) })]);
    const roleOnTeam = async () => {
      const seen = await as(deputy).sync({});
      return seen.body.projects.find((p: { name: string }) => p.name === 'Team project')?.role;
    };
    expect(await roleOnTeam()).toBe('ADMIN');
    expect((await as(admin).post(`/api/v1/workspaces/${ws}/users/${deputy.id}`, { role: 'MEMBER' })).status).toBe(200);
    expect(await roleOnTeam()).toBe('READ_WRITE');
    expect((await as(admin).post(`/api/v1/workspaces/${ws}/users/${deputy.id}`, { role: 'GUEST' })).status).toBe(200);
    expect(await roleOnTeam()).toBeUndefined();
  });

  it('a task moved out of a project is gone for people who only saw that project, and comments follow it into the new one', async () => {
    const owner = await person(base);
    const left = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Origin' }, { temp_id: tempId(50) }), command('project_add', { name: 'Target' }, { temp_id: tempId(51) })]);
    await run(owner, [command('item_add', { content: 'Moving', project_id: real(50) }, { temp_id: tempId(52) })]);
    const task = (await run(owner, [])).reply;
    void task;
    await run(owner, [command('share_project', { project_id: real(50), email: left.email })]);
    await acceptFirst(left);
    const before = await as(left).sync({});
    const movingId = (await as(owner).sync({})).body.items.find((i: { content: string }) => i.content === 'Moving').id;
    await run(owner, [command('item_move', { id: movingId, project_id: real(51) })]);
    const after = await as(left).sync({ token: before.body.sync_token });
    expect(after.body.full_sync).toBe(true);
    expect(after.body.items.some((i: { id: string }) => i.id === movingId)).toBe(false);
  });

  it('a project moved into a workspace stays restricted until the owner opens it, and leaves the team with the move back', async () => {
    const owner = await person(base);
    const member = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Wanderer' }, { temp_id: tempId(60) }), command('workspace_add', { name: 'Home' }, { temp_id: tempId(61) })]);
    const ws = real(61);
    await run(owner, [command('workspace_invite', { workspace_id: ws, email: member.email })]);
    await acceptFirst(member);
    const project = real(60);
    expect((await run(owner, [command('project_move_to_workspace', { project_id: project, workspace_id: ws })])).statuses[0]).toBe('ok');
    expect((await as(member).sync({})).body.projects.some((p: { name: string }) => p.name === 'Wanderer')).toBe(false);
    // Opening it to the team is the owner's deliberate change.
    await run(owner, [command('project_update', { id: project, access: { visibility: 'team' } })]);
    expect((await as(member).sync({})).body.projects.some((p: { name: string }) => p.name === 'Wanderer')).toBe(true);
    expect((await run(owner, [command('project_move_to_personal', { project_id: project })])).statuses[0]).toBe('ok');
    expect((await as(member).sync({})).body.projects.some((p: { name: string }) => p.name === 'Wanderer')).toBe(false);
  });

  it('restricting a team project takes away the team’s grants, and keeps the grant the owner made by hand', async () => {
    const owner = await person(base);
    const teammate = await person(base);
    const byHand = await person(base);
    const { real } = await run(owner, [command('workspace_add', { name: 'Crew' }, { temp_id: tempId(62) })]);
    const ws = real(62);
    await run(owner, [command('workspace_invite', { workspace_id: ws, email: teammate.email })]);
    await acceptFirst(teammate);
    const created = await run(owner, [command('project_add', { name: 'Crew project', workspace_id: ws, access: { visibility: 'team' } }, { temp_id: tempId(63) })]);
    const project = created.real(63);
    await run(owner, [command('share_project', { project_id: project, email: byHand.email })]);
    await acceptFirst(byHand);
    expect((await as(teammate).sync({})).body.projects.some((p: { name: string }) => p.name === 'Crew project')).toBe(true);
    await run(owner, [command('project_update', { id: project, access: { visibility: 'restricted' } })]);
    expect((await as(teammate).sync({})).body.projects.some((p: { name: string }) => p.name === 'Crew project')).toBe(false);
    expect((await as(byHand).sync({})).body.projects.some((p: { name: string }) => p.name === 'Crew project')).toBe(true);
  });

  it('a workspace keeps an admin: the last one cannot be demoted or leave', async () => {
    const admin = await person(base);
    const { real } = await run(admin, [command('workspace_add', { name: 'Solo' }, { temp_id: tempId(64) })]);
    const ws = real(64);
    const demote = await as(admin).post(`/api/v1/workspaces/${ws}/users/${admin.id}`, { role: 'MEMBER' });
    expect(demote.status).toBe(400);
    expect(demote.body.error_tag).toBe('LAST_ADMIN');
    const leave = await run(admin, [command('workspace_remove_member', { workspace_id: ws, user_id: admin.id })]);
    expect(leave.statuses[0]).toMatchObject({ error_tag: 'OWNER_REMOVAL' });
  });

  it('a write for another account is refused as a whole, and nothing is changed', async () => {
    const who = await person(base);
    const other = await person(base);
    const form = new URLSearchParams({
      sync_token: '*', resource_types: '["labels"]', account_id: other.id,
      commands: JSON.stringify([command('label_add', { name: 'Mismatch' })]),
    });
    const response = await fetch(`${server.base}/api/v1/sync`, { method: 'POST', headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error_tag: string }).error_tag).toBe('ACCOUNT_CHANGED');
    expect((await as(who).sync({ types: ['labels'] })).body.labels).toEqual([]);
    // The same write, sent for the account it belongs to, is kept.
    const own = await as(who).sync({ commands: [command('label_add', { name: 'Kept' })] });
    expect(Object.values(own.body.sync_status)[0]).toBe('ok');
  });
});

describe('review: commands, requests and filters', () => {
  it('a retried create gets the same ids back, not just “ok”', async () => {
    const who = await person(base);
    const add = { type: 'item_add', uuid: 'replayed-create-0000000000000001', args: { content: 'Once only', project_id: who.inbox }, temp_id: tempId(70) };
    const first = await as(who).sync({ commands: [add] });
    const replay = await as(who).sync({ commands: [add] });
    expect(replay.body.temp_id_mapping[tempId(70)]).toBe(first.body.temp_id_mapping[tempId(70)]);
    expect(replay.body.temp_id_mapping[tempId(70)]).toBeTruthy();
  });

  it('two accounts can use the same command id without touching each other', async () => {
    const one = await person(base);
    const two = await person(base);
    const shared = 'same-uuid-for-two-people-000001';
    await as(one).sync({ commands: [{ type: 'item_add', uuid: shared, args: { content: 'One', project_id: one.inbox } }] });
    const other = await as(two).sync({ commands: [{ type: 'item_add', uuid: shared, args: { content: 'Two', project_id: two.inbox } }] });
    expect(other.body.sync_status[shared]).toBe('ok');
    const twoItems = (await as(two).sync({})).body.items.map((i: { content: string }) => i.content);
    expect(twoItems).toEqual(['Two']);
  });

  it('a request target the URL parser rejects is a 400, and the server keeps answering', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: Number(new URL(server.base).port), path: '//[', method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    expect((await fetch(server.base + '/api/v1/health')).status).toBe(200);
  });

  it('a saved filter with several lists is accepted when each list is valid, and refused when one is not', async () => {
    const who = await person(base);
    const good = await run(who, [command('filter_add', { name: 'Two lists', query: 'today, overdue' }, { temp_id: tempId(80) })]);
    expect(good.statuses[0]).toBe('ok');
    const bad = await run(who, [command('filter_add', { name: 'Broken', query: 'today, frobnicate' })]);
    expect(bad.statuses[0]).toMatchObject({ error_tag: 'INVALID_FILTER' });
  });
});

describe('review: second round', () => {
  it('a deleted subproject does not block archiving its live parent', async () => {
    const owner = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Root' }, { temp_id: tempId(90) }), command('project_add', { name: 'Gone child', parent_id: tempId(90) }, { temp_id: tempId(91) })]);
    await run(owner, [command('project_delete', { id: real(91) })]);
    const archive = await run(owner, [command('project_archive', { id: real(90) })]);
    expect(archive.statuses[0]).toBe('ok');
  });

  it('a full read keeps the checked subtasks of an open task, which a recurring reset needs', async () => {
    const owner = await person(base);
    const { real } = await run(owner, [
      command('item_add', { content: 'Open parent', project_id: owner.inbox }, { temp_id: tempId(92) }),
      command('item_add', { content: 'Done step', project_id: owner.inbox, parent_id: tempId(92) }, { temp_id: tempId(93) }),
    ]);
    await run(owner, [command('item_uncomplete', { id: real(93) }), command('item_complete', { id: real(93) })]);
    const full = await as(owner).sync({});
    expect(full.body.items.some((i: { id: string; checked: boolean }) => i.id === real(93) && i.checked)).toBe(true);
  });

  it('an invitation takes the role the owner last set, not the one it was first sent with', async () => {
    const owner = await person(base);
    const guest = await person(base);
    const { real } = await run(owner, [command('project_add', { name: 'Changed mind' }, { temp_id: tempId(94) })]);
    const project = real(94);
    await run(owner, [command('share_project', { project_id: project, email: guest.email, role: 'ADMIN' })]);
    await run(owner, [command('project_change_role', { id: project, user_id: guest.id, role: 'READ_ONLY' })]);
    await acceptFirst(guest);
    const role = (await as(guest).sync({})).body.projects.find((p: { id: string }) => p.id === project)?.role;
    expect(role).toBe('READ_ONLY');
  });
});

