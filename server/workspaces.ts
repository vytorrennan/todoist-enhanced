import { ApiFailure, type Db, newId, nextSeq } from './db';
import { isWorkspaceRole, requireWorkspace, workspaceRole } from './access';
import { type Args, type Ctx, id as idArg, resolveId, text } from './ctx';
import { findUserByEmail, joinWorkspace, leaveWorkspace, newInvitation, notRegistered, notify, sameEmail } from './sharing';
import { folderOut } from './serialize';
import { activeProjectsOf, pageOf } from './projects';
import { projectOut } from './serialize';

/** Workspaces (teams): their members, their folders, and the projects inside them. */

const MAX_NAME = 120;

export function addWorkspace(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const name = text(args, 'name', { required: true, max: MAX_NAME }) ?? '';
  const id = newId();
  if (tempId) ctx.temps.set(tempId, id);
  db.prepare(`INSERT INTO workspaces (id, name, created_by, created_at, seq) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name, viewer.id, ctx.now, nextSeq(db));
  joinWorkspace(db, id, viewer.id, 'ADMIN');
}

export function updateWorkspace(ctx: Ctx, args: Args): void {
  const id = resolveId(ctx, idArg(args, 'id', true));
  requireWorkspace(ctx.db, id, ctx.viewer.id, true);
  const name = text(args, 'name', { required: true, max: MAX_NAME });
  if (name !== undefined) ctx.db.prepare('UPDATE workspaces SET name = ?, seq = ? WHERE id = ?').run(name, nextSeq(ctx.db), id);
}

export function inviteToWorkspace(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const workspaceId = resolveId(ctx, idArg(args, 'workspace_id', true));
  requireWorkspace(db, workspaceId, viewer.id, true);
  const email = text(args, 'email', { required: true, max: 254 })?.toLowerCase() ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiFailure.badRequest('Enter a valid email address.', 'INVALID_EMAIL');
  if (sameEmail(email, viewer.email)) throw ApiFailure.badRequest('You are already in this workspace.', 'ALREADY_MEMBER');
  const role = typeof args.role === 'string' ? args.role : 'MEMBER';
  if (!isWorkspaceRole(role)) throw ApiFailure.badRequest('That role cannot be given.', 'INVALID_ROLE');
  const target = findUserByEmail(db, email);
  if (!target) throw notRegistered();
  if (workspaceRole(db, workspaceId, target.id)) throw ApiFailure.badRequest('That person is already in this workspace.', 'ALREADY_MEMBER');
  const invitation = newInvitation(db, {
    kind: 'workspace', workspaceId, email, userId: target?.id ?? null, invitedBy: viewer.id, role,
  });
  if (target) {
    notify(db, target.id, 'workspace_invitation_created', {
      from_uid: viewer.id,
      from_user: { full_name: viewer.full_name, email: viewer.email },
      workspace_id: workspaceId,
      invitation_id: invitation.id,
      invitation_secret: invitation.secret,
      about: workspaceId,
    });
  }
}

/** A workspace always keeps an admin: without one nobody can invite, add a folder, or make an admin again. */
export function refuseLastAdmin(db: Db, workspaceId: string, userId: string): void {
  const admins = db.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'ADMIN'`)
    .get(workspaceId) as { n: number };
  const isAdmin = workspaceRole(db, workspaceId, userId) === 'ADMIN';
  if (isAdmin && admins.n <= 1) throw ApiFailure.badRequest('A workspace needs at least one admin. Make someone else an admin first.', 'LAST_ADMIN');
}

export function removeFromWorkspace(ctx: Ctx, workspaceId: string, userId: string): void {
  const { db, viewer } = ctx;
  const own = userId === viewer.id;
  requireWorkspace(db, workspaceId, viewer.id, !own);
  if (!workspaceRole(db, workspaceId, userId)) throw ApiFailure.notFound('That person is not in this workspace.', 'NOT_A_MEMBER');
  const creator = db.prepare('SELECT created_by FROM workspaces WHERE id = ?').get(workspaceId) as { created_by: string };
  if (creator.created_by === userId) throw ApiFailure.forbidden('The creator of a workspace stays in it.', 'OWNER_REMOVAL');
  refuseLastAdmin(db, workspaceId, userId);
  leaveWorkspace(db, workspaceId, userId);
}

export function setWorkspaceRole(ctx: Ctx, workspaceId: string, userId: string, role: unknown): void {
  const { db } = ctx;
  requireWorkspace(db, workspaceId, ctx.viewer.id, true);
  if (!isWorkspaceRole(role)) throw ApiFailure.badRequest('That role cannot be given.', 'INVALID_ROLE');
  const current = workspaceRole(db, workspaceId, userId);
  if (!current) throw ApiFailure.notFound('That person is not in this workspace.', 'NOT_A_MEMBER');
  if (current === role) return;
  if (current === 'ADMIN' && role !== 'ADMIN') refuseLastAdmin(db, workspaceId, userId);
  joinWorkspace(db, workspaceId, userId, role);
}

export function addFolder(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const workspaceId = resolveId(ctx, idArg(args, 'workspace_id', true));
  requireWorkspace(db, workspaceId, viewer.id, true);
  const name = text(args, 'name', { required: true, max: MAX_NAME }) ?? '';
  const last = db.prepare('SELECT COALESCE(MAX(child_order), 0) AS n FROM folders WHERE workspace_id = ? AND is_deleted = 0')
    .get(workspaceId) as { n: number };
  const id = newId();
  if (tempId) ctx.temps.set(tempId, id);
  db.prepare(`INSERT INTO folders (id, workspace_id, name, child_order, created_by, seq) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, name, last.n + 1, viewer.id, nextSeq(db));
}

function ownFolder(ctx: Ctx, id: string, workspaceArg?: unknown) {
  const folder = ctx.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as
    | { id: string; workspace_id: string; name: string; child_order: number; is_deleted: number } | undefined;
  // A folder in a workspace the person is not in answers as one that does not exist: its workspace is not revealed.
  if (!folder || folder.is_deleted || !workspaceRole(ctx.db, folder.workspace_id, ctx.viewer.id)) {
    throw ApiFailure.notFound('That folder does not exist.', 'FOLDER_NOT_FOUND');
  }
  if (workspaceArg !== undefined && resolveId(ctx, workspaceArg) !== folder.workspace_id) {
    throw ApiFailure.badRequest('That folder is not in this workspace.', 'FOLDER_NOT_IN_WORKSPACE');
  }
  requireWorkspace(ctx.db, folder.workspace_id, ctx.viewer.id, true);
  return folder;
}

export function updateFolder(ctx: Ctx, args: Args): void {
  const folder = ownFolder(ctx, resolveId(ctx, idArg(args, 'id', true)), args.workspace_id);
  const name = text(args, 'name', { required: true, max: MAX_NAME });
  if (name !== undefined) ctx.db.prepare('UPDATE folders SET name = ?, seq = ? WHERE id = ?').run(name, nextSeq(ctx.db), folder.id);
}

export function deleteFolder(ctx: Ctx, args: Args): void {
  const folder = ownFolder(ctx, resolveId(ctx, idArg(args, 'id', true)), args.workspace_id);
  const { db } = ctx;
  // Projects in it stay in the workspace, at its top level.
  db.prepare('UPDATE projects SET folder_id = NULL, seq = ? WHERE folder_id = ?').run(nextSeq(db), folder.id);
  db.prepare('UPDATE folders SET is_deleted = 1, seq = ? WHERE id = ?').run(nextSeq(db), folder.id);
}

export const WORKSPACE_COMMANDS = {
  workspace_add: (ctx: Ctx, args: Args, temp?: string) => addWorkspace(ctx, args, temp),
  workspace_update: (ctx: Ctx, args: Args) => updateWorkspace(ctx, args),
  workspace_invite: (ctx: Ctx, args: Args) => inviteToWorkspace(ctx, args),
  workspace_remove_member: (ctx: Ctx, args: Args) => removeFromWorkspace(ctx, resolveId(ctx, args.workspace_id), resolveId(ctx, args.user_id)),
  folder_add: (ctx: Ctx, args: Args, temp?: string) => addFolder(ctx, args, temp),
  folder_update: (ctx: Ctx, args: Args) => updateFolder(ctx, args),
  folder_delete: (ctx: Ctx, args: Args) => deleteFolder(ctx, args),
};

/** Reads ----------------------------------------------------------------- */

export function workspaceUsers(db: Db, viewerId: string, workspaceId: string, cursor: string | undefined) {
  requireWorkspace(db, workspaceId, viewerId);
  const rows = db.prepare(`SELECT wm.user_id, u.full_name, u.email, wm.role FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? ORDER BY u.full_name, u.email`)
    .all(workspaceId) as Array<{ user_id: string; full_name: string; email: string; role: string }>;
  const page = pageOf(rows, cursor, 100);
  return {
    workspace_users: page.items.map((row) => ({ user_id: row.user_id, full_name: row.full_name, user_email: row.email, role: row.role, is_deleted: false })),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
  };
}

export function workspaceProjects(db: Db, viewerId: string, workspaceId: string, archived: boolean, cursor: string | undefined) {
  requireWorkspace(db, workspaceId, viewerId);
  const page = pageOf(activeProjectsOf(db, viewerId, workspaceId, archived), cursor, 100);
  return { workspace_projects: page.items.map(projectOut), next_cursor: page.next_cursor, has_more: page.has_more };
}

export function workspaceFolders(db: Db, viewerId: string, workspaceId: string, cursor: string | undefined) {
  requireWorkspace(db, workspaceId, viewerId);
  const rows = db.prepare('SELECT * FROM folders WHERE workspace_id = ? AND is_deleted = 0 ORDER BY child_order, name')
    .all(workspaceId) as Array<{ id: string; workspace_id: string; name: string; child_order: number; is_deleted: number }>;
  const page = pageOf(rows, cursor, 200);
  return { results: page.items.map(folderOut), next_cursor: page.next_cursor };
}

