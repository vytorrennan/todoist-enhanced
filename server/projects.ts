import { ApiFailure, type Db, newId, nextSeq, nowIso } from './db';
import { canBeAssigned, requireProject, requireWorkspace, workspaceRole } from './access';
import { type Args, type Ctx, endOfList, id as idArg, integer, orderKeyArg, resolveId, text, truthy, wholeNumber } from './ctx';
import { requireFullSync, requireFullSyncFor, revokeWorkspaceGrants, setMembership } from './sharing';
import { collaboratorOut, type ProjectRow, sectionOut } from './serialize';
import { subtreeIds as itemSubtree } from './items';

/** Projects, their nesting and archiving, and sections inside them. */

const MAX_NAME = 300;

/** Every project under this one, itself included. */
export function projectTree(db: Db, rootId: string): string[] {
  // Deleted projects are not part of anything that can still be changed.
  const rows = db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM projects WHERE id = ? AND is_deleted = 0
      UNION ALL
      SELECT projects.id FROM projects JOIN tree ON projects.parent_id = tree.id WHERE projects.is_deleted = 0
    ) SELECT id FROM tree`).all(rootId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Where a project goes in a person's own sidebar: last among the projects with the same parent. */
function sidebarEnd(db: Db, userId: string, parentId: string | null) {
  const last = db.prepare(`SELECT m.child_order AS num, m.order_key AS key FROM project_members m
      JOIN projects p ON p.id = m.project_id
      WHERE m.user_id = ? AND m.state = 'active' AND p.parent_id IS ?
      ORDER BY m.child_order DESC, m.order_key DESC LIMIT 1`).get(userId, parentId) as { num: number; key: string | null } | undefined;
  return { child_order: (last?.num ?? 0) + 1, order_key: endOfList(db, 'project_members', 'user_id = ? AND state = ?', [userId, 'active'], 'order_key', 'child_order').key };
}

const cleanColor = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[a-z_]{2,40}$/.test(value)) throw ApiFailure.badRequest('That colour is not one the app knows.', 'INVALID_COLOR');
  return value;
};

/** The access levels the server keeps. `public` links are not offered, so they are refused rather than kept as a promise. */
export function visibilityOf(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (value !== 'restricted' && value !== 'team') throw ApiFailure.badRequest('That access level is not one this server keeps.', 'INVALID_ACCESS');
  return value;
}

/**
 * Gives the non-guest members of a workspace a place in a team project. A
 * restricted project is not touched: only people added to it by hand are in it.
 */
export function admitWorkspaceMembers(db: Db, projectId: string, workspaceId: string): void {
  const members = db.prepare(`SELECT user_id, role FROM workspace_members WHERE workspace_id = ? AND role != 'GUEST'`)
    .all(workspaceId) as Array<{ user_id: string; role: string }>;
  for (const member of members) {
    const existing = db.prepare('SELECT state FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, member.user_id) as { state: string } | undefined;
    // A grant already in place, and an invitation still waiting for an answer, are left as they are: the invitation is the person's own to accept or decline.
    if (existing?.state === 'active' || existing?.state === 'invited') continue;
    setMembership(db, projectId, member.user_id, { role: member.role === 'ADMIN' ? 'ADMIN' : 'READ_WRITE', state: 'active', via: 'workspace' });
    requireFullSync(db, member.user_id);
  }
}

/**
 * Moves a project (with its subprojects) into a workspace, at its top level.
 * Its visibility stays as it is: a restricted project stays restricted, and
 * opening it to the team is a separate, deliberate change. Only the owner
 * moves a project: a move decides who can see it.
 */
export function moveProjectToWorkspace(ctx: Ctx, id: string, workspaceId: string): void {
  const { db, viewer } = ctx;
  requireProject(db, id, viewer.id, 'owner');
  if (requireWorkspace(db, workspaceId, viewer.id) === 'GUEST') {
    throw ApiFailure.forbidden('Guests cannot add projects to a workspace.', 'WORKSPACE_ROLE_TOO_LOW');
  }
  const project = db.prepare('SELECT is_inbox, workspace_id FROM projects WHERE id = ?').get(id) as { is_inbox: number; workspace_id: string | null };
  if (project.is_inbox) throw ApiFailure.badRequest('The Inbox stays where it is.', 'INBOX');
  if (project.workspace_id === workspaceId) return;
  const tree = projectTree(db, id);
  for (const projectId of tree) requireProject(db, projectId, viewer.id, 'owner');
  for (const projectId of tree) {
    // The team it came from no longer gives anything; the new team gives what its visibility allows.
    revokeWorkspaceGrants(db, projectId);
    db.prepare('UPDATE projects SET workspace_id = ?, folder_id = NULL, parent_id = ?, seq = ? WHERE id = ?')
      .run(workspaceId, projectId === id ? null : (db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(projectId) as { parent_id: string | null }).parent_id, nextSeq(db), projectId);
    const row = db.prepare('SELECT access_visibility FROM projects WHERE id = ?').get(projectId) as { access_visibility: string };
    if (row.access_visibility === 'team') admitWorkspaceMembers(db, projectId, workspaceId);
  }
}

/**
 * Takes a project out of its workspace. Everyone else loses access: the
 * owner can share it again, and nobody keeps a place they were given only
 * through the team.
 */
export function moveProjectToPersonal(ctx: Ctx, id: string): void {
  const { db, viewer } = ctx;
  requireProject(db, id, viewer.id, 'owner');
  const project = db.prepare('SELECT is_inbox, workspace_id FROM projects WHERE id = ?').get(id) as { is_inbox: number; workspace_id: string | null };
  if (project.is_inbox) throw ApiFailure.badRequest('The Inbox stays where it is.', 'INBOX');
  if (!project.workspace_id) return;
  const tree = projectTree(db, id);
  for (const projectId of tree) requireProject(db, projectId, viewer.id, 'owner');
  for (const projectId of tree) {
    // The team's grants end with the team. The owner's own invitations and grants stay: they were made by hand.
    revokeWorkspaceGrants(db, projectId);
    db.prepare("UPDATE projects SET workspace_id = NULL, folder_id = NULL, access_visibility = 'restricted', seq = ? WHERE id = ?").run(nextSeq(db), projectId);
  }
  db.prepare('UPDATE projects SET parent_id = NULL, seq = ? WHERE id = ?').run(nextSeq(db), id);
}

export function addProject(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const name = text(args, 'name', { required: true, max: MAX_NAME }) ?? '';
  const color = cleanColor(args.color) ?? 'charcoal';
  const parentArg = idArg(args, 'parent_id');
  const parentId = parentArg ? resolveId(ctx, parentArg) : null;
  // Only the owner of a project nests projects under it, so the owner can always manage the whole branch.
  let parentWorkspace: string | null = null;
  if (parentId) {
    requireProject(db, parentId, viewer.id, 'owner');
    const parent = db.prepare('SELECT workspace_id, is_inbox FROM projects WHERE id = ?').get(parentId) as { workspace_id: string | null; is_inbox: number };
    if (parent.is_inbox) throw ApiFailure.badRequest('The Inbox cannot hold projects.', 'INBOX');
    parentWorkspace = parent.workspace_id;
  }
  const workspaceArg = idArg(args, 'workspace_id');
  // A subproject lives in its parent's space unless it is named another.
  const workspaceId = workspaceArg ? resolveId(ctx, workspaceArg) : parentWorkspace;
  let folderId: string | null = null;
  if (workspaceId) {
    const role = requireWorkspace(db, workspaceId, viewer.id);
    if (role === 'GUEST') throw ApiFailure.forbidden('Guests cannot create projects in a workspace.', 'WORKSPACE_ROLE_TOO_LOW');
    const folder = idArg(args, 'folder_id');
    if (folder) {
      const row = db.prepare('SELECT workspace_id FROM folders WHERE id = ? AND is_deleted = 0').get(resolveId(ctx, folder)) as { workspace_id: string } | undefined;
      if (!row || row.workspace_id !== workspaceId) throw ApiFailure.badRequest('That folder is not in this workspace.', 'FOLDER_NOT_IN_WORKSPACE');
      folderId = resolveId(ctx, folder);
    }
  }
  if (parentId && parentWorkspace !== workspaceId) throw ApiFailure.badRequest('A project nests in a project of the same workspace.', 'PARENT_IN_OTHER_WORKSPACE');
  const id = newId();
  if (tempId) ctx.temps.set(tempId, id);
  const visibility = visibilityOf((args.access as { visibility?: unknown } | undefined)?.visibility, workspaceId ? 'team' : 'restricted');
  db.prepare(`INSERT INTO projects (id, name, description, color, parent_id, workspace_id, folder_id, view_style,
      access_visibility, created_by, created_at, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, name, text(args, 'description', { max: 20_000 }) ?? '', color, parentId, workspaceId, folderId,
    typeof args.view_style === 'string' ? args.view_style : 'list', visibility, viewer.id, ctx.now, nextSeq(db),
  );
  const place = sidebarEnd(db, viewer.id, parentId);
  db.prepare(`INSERT INTO project_members (project_id, user_id, role, state, is_favorite, child_order, order_key, joined_at, seq)
    VALUES (?, ?, 'CREATOR', 'active', ?, ?, ?, ?, ?)`).run(
    id, viewer.id, truthy(args.is_favorite) ? 1 : 0, typeof args.child_order === 'number' ? args.child_order : place.child_order,
    orderKeyArg(args.order_key) ?? place.order_key, ctx.now, nextSeq(db),
  );
  if (workspaceId && visibility === 'team') admitWorkspaceMembers(db, id, workspaceId);
}

export function updateProject(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const id = resolveId(ctx, idArg(args, 'id', true));
  const membership = requireProject(db, id, viewer.id, 'read');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
  const content: Record<string, unknown> = {};
  if ('name' in args) content.name = text(args, 'name', { required: true, max: MAX_NAME });
  // A color that is not given, or is null, keeps the one the project has: every project has a color.
  if ('color' in args) content.color = cleanColor(args.color) ?? project.color;
  if ('description' in args) content.description = text(args, 'description', { max: 20_000 }) ?? '';
  if ('view_style' in args && typeof args.view_style === 'string') content.view_style = args.view_style;
  if (Object.keys(content).length) {
    requireProject(db, id, viewer.id, 'write');
    const assignments = Object.keys(content).map((key) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE projects SET ${assignments}, seq = @seq WHERE id = @id`).run({ ...content, seq: nextSeq(db), id });
  }
  if ('access' in args && args.access && typeof (args.access as { visibility?: unknown }).visibility === 'string') {
    requireProject(db, id, viewer.id, 'admin');
    const next = visibilityOf((args.access as { visibility: unknown }).visibility, 'restricted');
    const before = db.prepare('SELECT access_visibility, workspace_id FROM projects WHERE id = ?').get(id) as { access_visibility: string; workspace_id: string | null };
    db.prepare('UPDATE projects SET access_visibility = ?, seq = ? WHERE id = ?').run(next, nextSeq(db), id);
    // Restricting takes away what the team gave; opening to the team gives it to the team.
    if (next === 'restricted' && before.access_visibility === 'team') revokeWorkspaceGrants(db, id);
    if (next === 'team' && before.workspace_id) admitWorkspaceMembers(db, id, before.workspace_id);
  }
  if ('folder_id' in args) {
    requireProject(db, id, viewer.id, 'admin');
    const folder = args.folder_id ? resolveId(ctx, args.folder_id) : null;
    // A folder takes a project out of its parent, which changes the shared tree: only the owner of a subproject does that.
    if (folder && (db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(id) as { parent_id: string | null }).parent_id) {
      requireProject(db, id, viewer.id, 'owner');
    }
    if (folder) {
      const row = db.prepare('SELECT workspace_id FROM folders WHERE id = ? AND is_deleted = 0').get(folder) as { workspace_id: string } | undefined;
      // The folder must be in this project's workspace, and the person must be in that workspace to file the project in it.
      // A guest of the workspace does not arrange its folders: a member or an admin does.
      const role = row ? workspaceRole(db, row.workspace_id, viewer.id) : null;
      if (!row || row.workspace_id !== project.workspace_id || !role || role === 'GUEST') {
        throw ApiFailure.badRequest('That folder is not in this project’s workspace.', 'FOLDER_NOT_IN_WORKSPACE');
      }
    }
    db.prepare('UPDATE projects SET folder_id = ?, seq = ? WHERE id = ?').run(folder, nextSeq(db), id);
    if (folder) db.prepare('UPDATE projects SET parent_id = NULL, seq = ? WHERE id = ?').run(nextSeq(db), id);
  }
  // Favourite and collapsed are how this person sees the project, so they are theirs alone.
  const own: Record<string, unknown> = {};
  if ('is_favorite' in args) own.is_favorite = truthy(args.is_favorite) ? 1 : 0;
  if ('collapsed' in args || 'is_collapsed' in args) own.collapsed = truthy(args.collapsed ?? args.is_collapsed) ? 1 : 0;
  if ('child_order' in args) own.child_order = integer(args, 'child_order') ?? membership.child_order;
  const ownOrderKey = orderKeyArg(args.order_key);
  if (ownOrderKey !== undefined) own.order_key = ownOrderKey;
  const ownKeys = Object.keys(own);
  if (ownKeys.length) {
    const assignments = ownKeys.map((key) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE project_members SET ${assignments}, seq = @seq WHERE project_id = @project AND user_id = @user`)
      .run({ ...own, seq: nextSeq(db), project: id, user: viewer.id });
  }
  if ('parent_id' in args) moveProject(ctx, id, args.parent_id);
}

function moveProject(ctx: Ctx, id: string, parentArg: unknown): void {
  const { db, viewer } = ctx;
  // Where a project sits is shared by everyone who sees it, so only its owner moves it, and the whole branch must be the owner's.
  requireProject(db, id, viewer.id, 'owner');
  const parentId = parentArg ? resolveId(ctx, parentArg) : null;
  if (parentId) {
    const self = db.prepare('SELECT is_inbox FROM projects WHERE id = ?').get(id) as { is_inbox: number };
    if (self.is_inbox) throw ApiFailure.badRequest('The Inbox stays where it is.', 'INBOX');
    requireProject(db, parentId, viewer.id, 'owner');
    if (projectTree(db, id).includes(parentId)) throw ApiFailure.badRequest('A project cannot be moved under itself.', 'CYCLE');
    for (const member of projectTree(db, id)) requireProject(db, member, viewer.id, 'owner');
    if ((db.prepare('SELECT is_inbox FROM projects WHERE id = ?').get(parentId) as { is_inbox: number }).is_inbox) {
      throw ApiFailure.badRequest('The Inbox cannot hold projects.', 'INBOX');
    }
  }
  const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(id) as { workspace_id: string | null };
  if (parentId) {
    const parent = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(parentId) as { workspace_id: string | null };
    if (parent.workspace_id !== project.workspace_id) throw ApiFailure.badRequest('A project nests in a project of the same workspace.', 'PARENT_IN_OTHER_WORKSPACE');
  }
  db.prepare('UPDATE projects SET parent_id = ?, folder_id = CASE WHEN ? IS NULL THEN folder_id ELSE NULL END, seq = ? WHERE id = ?')
    .run(parentId, parentId, nextSeq(db), id);
  const place = sidebarEnd(db, viewer.id, parentId);
  db.prepare('UPDATE project_members SET child_order = ?, order_key = ?, seq = ? WHERE project_id = ? AND user_id = ?')
    .run(place.child_order, place.order_key, nextSeq(db), id, viewer.id);
}

export function reorderProjects(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const entries = Array.isArray(args.projects) ? args.projects as Array<{ id?: unknown; child_order?: unknown; order_key?: unknown }> : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw ApiFailure.badRequest('Each project order names a project.', 'INVALID_ARGUMENT');
    const id = resolveId(ctx, entry.id);
    const membership = requireProject(db, id, viewer.id, 'read');
    const childOrder = wholeNumber(entry.child_order ?? membership.child_order);
    if (childOrder === undefined) throw ApiFailure.badRequest('A child order is a whole number.', 'INVALID_ARGUMENT');
    db.prepare('UPDATE project_members SET child_order = ?, order_key = ?, seq = ? WHERE project_id = ? AND user_id = ?').run(
      childOrder,
      orderKeyArg(entry.order_key) ?? membership.order_key,
      nextSeq(db), id, viewer.id,
    );
  }
}

/** Archives a project and everything under it. The inbox cannot be archived. */
/** Brings a project and its subprojects back from the archive; each must be administered, as for archiving. */
export function unarchiveProject(ctx: Ctx, id: string): void {
  const { db, viewer } = ctx;
  requireProject(db, id, viewer.id, 'admin');
  for (const projectId of projectTree(db, id)) requireProject(db, projectId, viewer.id, 'admin');
  for (const projectId of projectTree(db, id)) {
    db.prepare('UPDATE projects SET is_archived = 0, archived_at = NULL, seq = ? WHERE id = ? AND is_deleted = 0')
      .run(nextSeq(db), projectId);
  }
}

export function archiveProject(ctx: Ctx, id: string): void {
  const { db, viewer } = ctx;
  requireProject(db, id, viewer.id, 'admin');
  const project = db.prepare('SELECT is_inbox FROM projects WHERE id = ?').get(id) as { is_inbox: number };
  if (project.is_inbox) throw ApiFailure.badRequest('The Inbox cannot be archived.', 'INBOX');
  // Subprojects can belong to someone else: every one of them must be administered too, or nothing changes.
  for (const projectId of projectTree(db, id)) requireProject(db, projectId, viewer.id, 'admin');
  for (const projectId of projectTree(db, id)) {
    db.prepare('UPDATE projects SET is_archived = 1, archived_at = COALESCE(archived_at, ?), seq = ? WHERE id = ? AND is_deleted = 0')
      .run(nowIso(), nextSeq(db), projectId);
  }
}

/** Deletes a project, its subprojects, and everything in them. Only the owner may. */
export function deleteProject(ctx: Ctx, id: string): void {
  const { db, viewer } = ctx;
  const membership = requireProject(db, id, viewer.id, 'read');
  if (membership.role !== 'CREATOR') throw ApiFailure.forbidden('Only the owner can delete a project.', 'PROJECT_ROLE_TOO_LOW');
  const project = db.prepare('SELECT is_inbox FROM projects WHERE id = ?').get(id) as { is_inbox: number };
  if (project.is_inbox) throw ApiFailure.badRequest('The Inbox cannot be deleted.', 'INBOX');
  for (const projectId of projectTree(db, id)) requireProject(db, projectId, viewer.id, 'owner');
  for (const projectId of projectTree(db, id)) {
    db.prepare('UPDATE projects SET is_deleted = 1, seq = ? WHERE id = ? AND is_deleted = 0').run(nextSeq(db), projectId);
    db.prepare('UPDATE items SET is_deleted = 1, seq = ? WHERE project_id = ? AND is_deleted = 0').run(nextSeq(db), projectId);
    db.prepare('UPDATE sections SET is_deleted = 1, seq = ? WHERE project_id = ? AND is_deleted = 0').run(nextSeq(db), projectId);
    db.prepare(`UPDATE notes SET is_deleted = 1, seq = ? WHERE is_deleted = 0 AND (project_id = ? OR item_id IN (SELECT id FROM items WHERE project_id = ?))`)
      .run(nextSeq(db), projectId, projectId);
    // The reminders of its tasks go with them, so a device that had them drops them.
    db.prepare('UPDATE reminders SET is_deleted = 1, seq = ? WHERE is_deleted = 0 AND item_id IN (SELECT id FROM items WHERE project_id = ?)').run(nextSeq(db), projectId);
    db.prepare('UPDATE location_reminders SET is_deleted = 1, seq = ? WHERE is_deleted = 0 AND item_id IN (SELECT id FROM items WHERE project_id = ?)').run(nextSeq(db), projectId);
  }
}

/** Sections -------------------------------------------------------------- */

export function addSection(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const projectId = resolveId(ctx, idArg(args, 'project_id', true));
  requireProject(db, projectId, viewer.id, 'write');
  const name = text(args, 'name', { required: true, max: MAX_NAME }) ?? '';
  const end = endOfList(db, 'sections', 'project_id = ? AND is_deleted = 0', [projectId], 'order_key', 'section_order');
  const id = newId();
  if (tempId) ctx.temps.set(tempId, id);
  db.prepare(`INSERT INTO sections (id, project_id, name, description, section_order, order_key, created_by, created_at, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, projectId, name, text(args, 'description', { max: 20_000 }) ?? '',
    integer(args, 'section_order') ?? end.order, orderKeyArg(args.order_key) ?? end.key,
    viewer.id, ctx.now, nextSeq(db),
  );
}

function sectionOf(ctx: Ctx, sectionId: string, need: 'read' | 'write' = 'write') {
  const row = ctx.db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId) as (Parameters<typeof sectionOut>[0] & { is_deleted: number }) | undefined;
  if (!row || row.is_deleted) throw ApiFailure.notFound('That section does not exist.', 'SECTION_NOT_FOUND');
  requireProject(ctx.db, row.project_id, ctx.viewer.id, need);
  return row;
}

export function updateSection(ctx: Ctx, args: Args): void {
  const { db } = ctx;
  const section = sectionOf(ctx, resolveId(ctx, idArg(args, 'id', true)));
  const set: Record<string, unknown> = {};
  if ('name' in args) set.name = text(args, 'name', { required: true, max: MAX_NAME });
  if ('description' in args) set.description = text(args, 'description', { max: 20_000 }) ?? '';
  if ('section_order' in args) {
    // A null order keeps the section where it is: every section has one.
    const order = integer(args, 'section_order');
    if (order !== undefined) set.section_order = order;
  }
  const sectionOrderKey = orderKeyArg(args.order_key);
  if (sectionOrderKey !== undefined) set.order_key = sectionOrderKey;
  if ('collapsed' in args) set.collapsed = truthy(args.collapsed) ? 1 : 0;
  const keys = Object.keys(set);
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE sections SET ${assignments}, seq = @seq WHERE id = @id`).run({ ...set, seq: nextSeq(db), id: section.id });
}

export function archiveSection(ctx: Ctx, id: string, archive: boolean): void {
  const section = sectionOf(ctx, resolveId(ctx, id));
  ctx.db.prepare('UPDATE sections SET is_archived = ?, archived_at = ?, seq = ? WHERE id = ?')
    .run(archive ? 1 : 0, archive ? ctx.now : null, nextSeq(ctx.db), section.id);
}

export function moveSection(ctx: Ctx, args: Args): void {
  const { db } = ctx;
  const section = sectionOf(ctx, resolveId(ctx, idArg(args, 'id', true)));
  const target = resolveId(ctx, idArg(args, 'project_id', true));
  requireProject(db, target, ctx.viewer.id, 'write');
  if (target === section.project_id) return;
  const end = endOfList(db, 'sections', 'project_id = ? AND is_deleted = 0', [target], 'order_key', 'section_order');
  db.prepare('UPDATE sections SET project_id = ?, section_order = ?, order_key = ?, seq = ? WHERE id = ?')
    .run(target, end.order, end.key, nextSeq(db), section.id);
  requireFullSyncFor(db, [section.project_id, target]);
  // The tasks in it come along, with everything under them.
  const tasks = db.prepare('SELECT id FROM items WHERE section_id = ? AND parent_id IS NULL').all(section.id) as Array<{ id: string }>;
  for (const task of tasks) {
    for (const id of itemSubtree(db, task.id)) {
      const row = db.prepare('SELECT responsible_uid FROM items WHERE id = ?').get(id) as { responsible_uid: string | null };
      const keep = row.responsible_uid && !canBeAssigned(db, target, row.responsible_uid) ? null : row.responsible_uid;
      // Everything under a task of the section is in the section too, whatever it was before.
      db.prepare('UPDATE items SET project_id = ?, section_id = ?, responsible_uid = ?, seq = ? WHERE id = ?')
        .run(target, section.id, keep, nextSeq(db), id);
    }
  }
}

export function deleteSection(ctx: Ctx, id: string): void {
  const { db } = ctx;
  const section = sectionOf(ctx, resolveId(ctx, id));
  db.prepare('UPDATE sections SET is_deleted = 1, seq = ? WHERE id = ?').run(nextSeq(db), section.id);
  // Tasks in it stay in the project, at its top level.
  db.prepare('UPDATE items SET section_id = NULL, seq = ? WHERE section_id = ?').run(nextSeq(db), section.id);
}

/** Reads: the archive, and what a person needs to share a project. */

interface Page<T> { items: T[]; next_cursor: string | null; has_more: boolean }

export function pageOf<T>(rows: T[], cursor: string | undefined, limit: number): Page<T> {
  const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const slice = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return { items: slice, next_cursor: more ? String(start + limit) : null, has_more: more };
}

export function archivedProjects(db: Db, viewerId: string, workspaceId: string | null): ProjectRow[] {
  const rows = db.prepare(`SELECT p.id, p.name, p.description, p.color, p.parent_id, p.workspace_id, p.folder_id, p.view_style,
        p.is_inbox, p.is_archived, p.archived_at, p.is_deleted, p.access_visibility, p.created_at, p.seq,
        m.role, m.is_favorite, m.collapsed, m.child_order, m.order_key,
        (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id AND x.state = 'active') AS shared_count
      FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? AND m.state = 'active'
      WHERE p.is_deleted = 0 AND p.is_archived = 1 AND p.workspace_id IS ?
      ORDER BY p.archived_at DESC, p.name`).all(viewerId, workspaceId) as ProjectRow[];
  return rows;
}

export function activeProjectsOf(db: Db, viewerId: string, workspaceId: string, archived: boolean): ProjectRow[] {
  return db.prepare(`SELECT p.id, p.name, p.description, p.color, p.parent_id, p.workspace_id, p.folder_id, p.view_style,
        p.is_inbox, p.is_archived, p.archived_at, p.is_deleted, p.access_visibility, p.created_at, p.seq,
        m.role, m.is_favorite, m.collapsed, m.child_order, m.order_key,
        (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id AND x.state = 'active') AS shared_count
      FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? AND m.state = 'active'
      WHERE p.is_deleted = 0 AND p.is_archived = ? AND p.workspace_id = ?
      ORDER BY p.name`).all(viewerId, archived ? 1 : 0, workspaceId) as ProjectRow[];
}

/** Who a project is shared with, as the app's people list reads it. */
export function projectPeople(db: Db, viewerId: string, projectId: string) {
  requireProject(db, projectId, viewerId, 'read');
  const states = db.prepare(`SELECT project_id, user_id, state, role FROM project_members
      WHERE project_id = ? AND state IN ('active', 'invited')`).all(projectId) as Array<{ project_id: string; user_id: string; state: string; role: string }>;
  const people = db.prepare(`SELECT u.id, u.email, u.full_name, u.image_id FROM users u
      WHERE u.id IN (SELECT user_id FROM project_members WHERE project_id = ? AND state IN ('active', 'invited'))`)
    .all(projectId) as Array<{ id: string; email: string; full_name: string; image_id: string | null }>;
  return { people: people.map(collaboratorOut), states };
}

