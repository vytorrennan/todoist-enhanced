import { randomBytes } from 'node:crypto';
import { ApiFailure, type Db, newId, nextSeq, nowIso } from './db';
import type { UserRow } from './auth';
import { isProjectRole, requireProject, type MembershipRow, workspaceRole } from './access';
import type { Ctx } from './ctx';

/**
 * Who is in a project or a workspace, and the invitations that put them there.
 *
 * A person is added as an invitation first: their project membership reads
 * `invited` until they accept, and only an active membership shows them the
 * project. Accepting, or being removed, changes what they may see, so the
 * person is sent everything again on their next sync (`access_seq`).
 */

/** The person's own address, lower case, as it is stored. */
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * There is no way to prove who controls an address without an account, so an
 * invitation to one would be claimed by whoever signed up with it first.
 */
export const notRegistered = () => ApiFailure.notFound('No account uses that address yet. Ask them to create one, then invite them.', 'NOT_REGISTERED');

export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as UserRow | undefined;
}

/** Tells a person something happened. Their next sync brings it. */
export function notify(db: Db, userId: string, type: string, data: Record<string, unknown>): string {
  const id = newId();
  db.prepare('INSERT INTO notifications (id, user_id, type, data, is_unread, created_at, seq) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(id, userId, type, JSON.stringify(data), nowIso(), nextSeq(db));
  return id;
}

/** A user's own account changed, so the people who share with them need to hear of it. */
export function touchUser(db: Db, userId: string): void {
  db.prepare('UPDATE users SET seq = ? WHERE id = ?').run(nextSeq(db), userId);
}

/** The person must read everything again, because what they can see has changed. */
export function requireFullSync(db: Db, userId: string): void {
  // Every device that last read before this sequence number gets everything again.
  const seq = nextSeq(db);
  db.prepare('UPDATE users SET access_seq = ?, seq = ? WHERE id = ?').run(seq, seq, userId);
}

/** Writes a membership row, returning the new row. A row that exists is updated in place. */
export function setMembership(
  db: Db,
  projectId: string,
  userId: string,
  values: { role: string; state: string; via?: 'direct' | 'workspace' },
): void {
  const existing = db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
  if (existing) {
    db.prepare('UPDATE project_members SET role = ?, state = ?, via = COALESCE(?, via), seq = ? WHERE project_id = ? AND user_id = ?')
      .run(values.role, values.state, values.via ?? null, nextSeq(db), projectId, userId);
  } else {
    const order = db.prepare('SELECT COALESCE(MAX(child_order), 0) + 1 AS n FROM project_members WHERE user_id = ?')
      .get(userId) as { n: number };
    db.prepare(`INSERT INTO project_members (project_id, user_id, role, state, via, child_order, joined_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, userId, values.role, values.state, values.via ?? 'direct', order.n, nowIso(), nextSeq(db));
  }
}

/**
 * Takes away the grants a team gave in one project (a restriction, or a move
 * out of the team). Grants the owner made by hand stay.
 */
export function revokeWorkspaceGrants(db: Db, projectId: string): void {
  const grants = db.prepare(`SELECT user_id FROM project_members WHERE project_id = ? AND state = 'active' AND via = 'workspace' AND role != 'CREATOR'`)
    .all(projectId) as Array<{ user_id: string }>;
  for (const grant of grants) {
    setMembership(db, projectId, grant.user_id, { role: 'READ_ONLY', state: 'removed', via: 'workspace' });
    requireFullSync(db, grant.user_id);
  }
}

/** A new invitation, with the secret the invitee needs to accept it. */
export function newInvitation(
  db: Db,
  input: { kind: 'project' | 'workspace'; projectId?: string; workspaceId?: string; email: string; userId: string | null; invitedBy: string; role: string },
): { id: string; secret: string } {
  // Earlier pending invitations to the same place are withdrawn when a new one is sent.
  if (input.kind === 'project') {
    db.prepare(`UPDATE invitations SET state = 'cancelled', responded_at = ? WHERE kind = 'project' AND project_id = ? AND email = ? AND state = 'pending'`)
      .run(nowIso(), input.projectId, input.email);
  } else {
    db.prepare(`UPDATE invitations SET state = 'cancelled', responded_at = ? WHERE kind = 'workspace' AND workspace_id = ? AND email = ? AND state = 'pending'`)
      .run(nowIso(), input.workspaceId, input.email);
  }
  const id = newId();
  const secret = randomBytes(18).toString('base64url');
  db.prepare(`INSERT INTO invitations (id, kind, project_id, workspace_id, email, user_id, invited_by, role, secret, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    id, input.kind, input.projectId ?? null, input.workspaceId ?? null, input.email, input.userId, input.invitedBy, input.role, secret, nowIso(),
  );
  return { id, secret };
}

const shareFields = (invitation: { id: string; secret: string; kind: string; project_id: string | null; workspace_id: string | null; invited_by: string; role: string }, inviter: UserRow) => {
  const from = { full_name: inviter.full_name, email: inviter.email };
  return {
    from_uid: inviter.id,
    from_user: from,
    invitation_id: invitation.id,
    invitation_secret: invitation.secret,
    project_id: invitation.project_id ?? undefined,
    workspace_id: invitation.workspace_id ?? undefined,
    role: invitation.role,
  };
};

/**
 * Invites a person to a project. An address with an account gets the
 * invitation straight away; one without gets it once it signs up.
 */
export function shareProject(ctx: Ctx, projectId: string, email: string, role: string | undefined): void {
  const { db, viewer } = ctx;
  requireProject(db, projectId, viewer.id, 'admin');
  if (sameEmail(email, viewer.email)) throw ApiFailure.badRequest('You are already in this project.', 'ALREADY_MEMBER');
  const chosen = role ?? 'READ_WRITE';
  if (!isProjectRole(chosen) || chosen === 'CREATOR') throw ApiFailure.badRequest('That role cannot be given.', 'INVALID_ROLE');
  const target = findUserByEmail(db, email);
  if (!target) throw notRegistered();
  {
    const current = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, target.id) as MembershipRow | undefined;
    if (current?.role === 'CREATOR') throw ApiFailure.badRequest('That person owns this project.', 'ALREADY_MEMBER');
    if (current?.state === 'active') {
      // Already in: a new role is applied, nothing else is sent.
      // An explicit share is the owner's choice: from now on it is a direct grant, whatever the team gave.
      if (current.role !== chosen || current.via !== 'direct') setMembership(db, projectId, target.id, { role: chosen, state: 'active', via: 'direct' });
      return;
    }
    setMembership(db, projectId, target.id, { role: chosen, state: 'invited', via: 'direct' });
  }
  const invitation = newInvitation(db, {
    kind: 'project', projectId, email: email.trim().toLowerCase(), userId: target?.id ?? null, invitedBy: viewer.id, role: chosen,
  });
  if (target) {
    notify(db, target.id, 'share_invitation_sent', {
      ...shareFields({ id: invitation.id, secret: invitation.secret, kind: 'project', project_id: projectId, workspace_id: null, invited_by: viewer.id, role: chosen }, viewer),
      about: projectId,
    });
  }
}

/** Accepts or refuses an invitation. The person answering must be the one it was sent to. */
export function answerInvitation(ctx: Ctx, invitationId: string, secret: string, accept: boolean): void {
  const { db, viewer } = ctx;
  const invitation = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId) as
    | { id: string; kind: string; project_id: string | null; workspace_id: string | null; email: string; user_id: string | null; invited_by: string; role: string; secret: string; state: string }
    | undefined;
  const mine = invitation && (invitation.user_id === viewer.id || (invitation.user_id === null && sameEmail(invitation.email, viewer.email)));
  if (!invitation || !mine || invitation.secret !== secret) throw ApiFailure.notFound('That invitation is not yours or no longer exists.', 'INVITATION_NOT_FOUND');
  if (invitation.state === 'cancelled') throw ApiFailure.notFound('That invitation has been withdrawn.', 'INVITATION_NOT_FOUND');
  if (invitation.state !== 'pending') {
    // Answered already: the same answer again changes nothing, a different one is refused.
    const answered = invitation.state === 'accepted' ? 'accepted' : 'rejected';
    if (answered === (accept ? 'accepted' : 'rejected')) return;
    throw ApiFailure.conflict('This invitation has already been answered.', 'INVITATION_ANSWERED');
  }
  const answered = accept ? 'accepted' : 'rejected';
  db.prepare('UPDATE invitations SET state = ?, user_id = ?, responded_at = ? WHERE id = ?')
    .run(answered, viewer.id, nowIso(), invitation.id);
  // The notification that carried the invitation shows it as answered, here and on every device.
  const notes = db.prepare(`SELECT id, data FROM notifications WHERE user_id = ? AND is_deleted = 0 AND data LIKE ?`)
    .all(viewer.id, `%${invitation.id}%`) as Array<{ id: string; data: string }>;
  for (const note of notes) {
    const data = JSON.parse(note.data) as Record<string, unknown>;
    if (data.invitation_id !== invitation.id) continue;
    db.prepare('UPDATE notifications SET data = ?, seq = ? WHERE id = ?')
      .run(JSON.stringify({ ...data, state: answered }), nextSeq(db), note.id);
  }

  if (invitation.kind === 'project') {
    if (!invitation.project_id) return;
    if (accept) {
      const project = db.prepare('SELECT is_deleted FROM projects WHERE id = ?').get(invitation.project_id) as { is_deleted: number } | undefined;
      if (!project || project.is_deleted) throw ApiFailure.notFound('That project no longer exists.', 'PROJECT_NOT_FOUND');
      // The invitation counts only while the person who sent it can still invite to the project.
      const sender = (db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND state = 'active'`)
        .get(invitation.project_id, invitation.invited_by) as { role: string } | undefined)?.role;
      if (sender !== 'CREATOR' && sender !== 'ADMIN') throw ApiFailure.forbidden('The person who sent this invitation can no longer invite to the project.', 'INVITER_CANNOT_INVITE');
      const pending = db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND state = 'invited'`)
        .get(invitation.project_id, viewer.id) as { role: string } | undefined;
      setMembership(db, invitation.project_id, viewer.id, { role: pending?.role ?? invitation.role, state: 'active', via: 'direct' });
      requireFullSync(db, viewer.id);
      touchUser(db, viewer.id);
    } else {
      setMembership(db, invitation.project_id, viewer.id, { role: invitation.role, state: 'removed', via: 'direct' });
    }
    notify(db, invitation.invited_by, accept ? 'share_invitation_accepted' : 'share_invitation_rejected', {
      from_uid: viewer.id,
      from_user: { full_name: viewer.full_name, email: viewer.email },
      project_id: invitation.project_id,
      about: invitation.project_id,
    });
    return;
  }

  if (invitation.kind === 'workspace' && invitation.workspace_id) {
    if (accept) {
      const sender = (db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(invitation.workspace_id, invitation.invited_by) as { role: string } | undefined)?.role;
      if (sender !== 'ADMIN') throw ApiFailure.forbidden('The person who sent this invitation can no longer invite to the workspace.', 'INVITER_CANNOT_INVITE');
      joinWorkspace(db, invitation.workspace_id, viewer.id, invitation.role);
    }
    notify(db, invitation.invited_by, 'workspace_invitation_created', {
      from_uid: viewer.id,
      from_user: { full_name: viewer.full_name, email: viewer.email },
      workspace_id: invitation.workspace_id,
      state: answered,
      about: invitation.workspace_id,
    });
  }
}

/**
 * Adds a person to a workspace: the membership, and an active membership in
 * every project of the workspace they can work in (guests are added by hand).
 */
export function joinWorkspace(db: Db, workspaceId: string, userId: string, role: string): void {
  const existing = workspaceRole(db, workspaceId, userId);
  if (existing) {
    db.prepare('UPDATE workspace_members SET role = ?, seq = ? WHERE workspace_id = ? AND user_id = ?')
      .run(role, nextSeq(db), workspaceId, userId);
  } else {
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at, seq) VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, userId, role, nowIso(), nextSeq(db));
  }
  db.prepare('UPDATE workspaces SET seq = ? WHERE id = ?').run(nextSeq(db), workspaceId);
  const projects = db.prepare('SELECT id, access_visibility FROM projects WHERE workspace_id = ? AND is_deleted = 0')
    .all(workspaceId) as Array<{ id: string; access_visibility: string }>;
  for (const project of projects) {
    // Team projects follow the workspace role; a restricted project only has the people the owner added.
    if (project.access_visibility !== 'team') continue;
    const mine = db.prepare('SELECT role, state, via FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(project.id, userId) as { role: string; state: string; via: string } | undefined;
    if (role === 'GUEST') {
      if (mine?.state === 'active' && mine.via === 'workspace' && mine.role !== 'CREATOR') {
        setMembership(db, project.id, userId, { role: mine.role, state: 'removed', via: 'workspace' });
      }
      continue;
    }
    // An invitation still waiting for an answer is not the workspace's to replace.
    if (mine?.state === 'invited') continue;
    if (mine?.state === 'active') {
      // A grant the owner made by hand is left as it is. Team grants move between admin and member with the role.
      if (mine.via !== 'workspace') continue;
      if (role === 'ADMIN' && mine.role === 'READ_WRITE') setMembership(db, project.id, userId, { role: 'ADMIN', state: 'active', via: 'workspace' });
      if (role === 'MEMBER' && mine.role === 'ADMIN') setMembership(db, project.id, userId, { role: 'READ_WRITE', state: 'active', via: 'workspace' });
      continue;
    }
    setMembership(db, project.id, userId, { role: role === 'ADMIN' ? 'ADMIN' : 'READ_WRITE', state: 'active', via: 'workspace' });
  }
  requireFullSync(db, userId);
}

/**
 * Everyone who can see one of these projects must read them again: a move between
 * projects changes who should see a task, and its comments, on the next sync.
 */
export function requireFullSyncFor(db: Db, projectIds: string[]): void {
  const people = new Set<string>();
  for (const projectId of new Set(projectIds)) {
    for (const row of db.prepare("SELECT user_id FROM project_members WHERE project_id = ? AND state = 'active'").all(projectId) as Array<{ user_id: string }>) {
      people.add(row.user_id);
    }
  }
  for (const userId of people) requireFullSync(db, userId);
}

/** The workspace's members are not all the people who can see its projects: a guest sees only what is shared with them. */
export function leaveWorkspace(db: Db, workspaceId: string, userId: string): void {
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
  const projects = db.prepare(`SELECT project_id FROM project_members WHERE user_id = ? AND state = 'active' AND via = 'workspace'
    AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?) AND role != 'CREATOR'`).all(userId, workspaceId) as Array<{ project_id: string }>;
  for (const row of projects) setMembership(db, row.project_id, userId, { role: 'READ_ONLY', state: 'removed', via: 'workspace' });
  db.prepare('UPDATE workspaces SET seq = ? WHERE id = ?').run(nextSeq(db), workspaceId);
  requireFullSync(db, userId);
}


/** Removes a person from a project, or leaves it. The owner's place cannot be given up this way. */
export function removeFromProject(ctx: Ctx, projectId: string, email: string): void {
  const { db, viewer } = ctx;
  const target = findUserByEmail(db, email);
  const self = target?.id === viewer.id;
  if (!self) requireProject(db, projectId, viewer.id, 'admin');
  else requireProject(db, projectId, viewer.id, 'read');
  const member = target
    ? db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, target.id) as MembershipRow | undefined
    : undefined;
  // Pending invitations to this address are withdrawn with the membership.
  db.prepare(`UPDATE invitations SET state = 'cancelled', responded_at = ? WHERE kind = 'project' AND project_id = ? AND email = ? AND state = 'pending'`)
    .run(nowIso(), projectId, email.trim().toLowerCase());
  if (!member || member.state === 'removed') return;
  if (member.role === 'CREATOR') throw ApiFailure.badRequest('The owner of a project cannot be removed from it.', 'OWNER_REMOVAL');
  setMembership(db, projectId, member.user_id, { role: member.role, state: 'removed' });
  if (member.state === 'active') requireFullSync(db, member.user_id);
  if (!self && member.state === 'active') {
    notify(db, member.user_id, 'user_removed_from_project', {
      from_uid: viewer.id,
      from_user: { full_name: viewer.full_name, email: viewer.email },
      project_id: projectId,
      about: projectId,
    });
  }
}

/** Changes what a member of a project may do. */
export function changeRole(ctx: Ctx, projectId: string, userId: string, role: unknown): void {
  const { db, viewer } = ctx;
  requireProject(db, projectId, viewer.id, 'admin');
  if (!isProjectRole(role) || role === 'CREATOR') throw ApiFailure.badRequest('That role cannot be given.', 'INVALID_ROLE');
  const member = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) as MembershipRow | undefined;
  if (!member || member.state === 'removed') throw ApiFailure.notFound('That person is not in this project.', 'NOT_A_MEMBER');
  if (member.role === 'CREATOR') throw ApiFailure.forbidden('The owner’s role cannot be changed.', 'OWNER_ROLE');
  setMembership(db, projectId, userId, { role, state: member.state });
  if (member.state === 'active') requireFullSync(db, userId);
}

export type { Ctx };
export { sameEmail };
