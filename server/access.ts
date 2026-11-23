import { ApiFailure, type Db } from './db';

/**
 * Who may see and change what.
 *
 * A project is visible to a person exactly when they have an active membership
 * in it. What they may do is set by the role on that membership. A project the
 * person cannot see is "not found", never "forbidden", so a stranger learns
 * nothing about it by asking.
 */

export const PROJECT_ROLES = ['CREATOR', 'ADMIN', 'READ_WRITE', 'READ_ONLY'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
const PROJECT_RANK: Record<string, number> = { CREATOR: 4, ADMIN: 3, READ_WRITE: 2, READ_ONLY: 1 };

export const WORKSPACE_ROLES = ['ADMIN', 'MEMBER', 'GUEST'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export interface MembershipRow {
  project_id: string;
  user_id: string;
  role: string;
  state: string;
  is_favorite: number;
  collapsed: number;
  child_order: number;
  order_key: string | null;
  via: string;
  joined_at: string;
  seq: number;
}

export type Need = 'read' | 'write' | 'admin' | 'owner';

/** The active membership of this person in this project, or undefined. */
export function activeMembership(db: Db, projectId: string, userId: string): MembershipRow | undefined {
  return db.prepare(`SELECT * FROM project_members WHERE project_id = ? AND user_id = ? AND state = 'active'`)
    .get(projectId, userId) as MembershipRow | undefined;
}

/**
 * Checks that a person may do `need` in a project. Throws not-found when they
 * cannot see the project at all, and forbidden when they can see it but the
 * role is too low.
 */
/** Whether a task in this project can be given to this person: an active member who may change it. */
export function canBeAssigned(db: Db, projectId: string, userId: string): boolean {
  const row = db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND state = 'active'`)
    .get(projectId, userId) as { role: string } | undefined;
  return row !== undefined && row.role !== 'READ_ONLY';
}

export function requireProject(db: Db, projectId: string, userId: string, need: Need): MembershipRow {
  const project = db.prepare('SELECT is_deleted FROM projects WHERE id = ?').get(projectId) as { is_deleted: number } | undefined;
  const membership = activeMembership(db, projectId, userId);
  if (!project || project.is_deleted || !membership) throw ApiFailure.notFound('That project does not exist.', 'PROJECT_NOT_FOUND');
  const rank = PROJECT_RANK[membership.role] ?? 0;
  const required = need === 'read' ? 1 : need === 'write' ? 2 : need === 'admin' ? 3 : 4;
  if (rank < required) throw ApiFailure.forbidden('Your role in this project does not allow that.', 'PROJECT_ROLE_TOO_LOW');
  return membership;
}

/**
 * The SQL that limits a query to projects this person can see. `column` is the
 * project id column of the table being read (`i.project_id` in a join).
 */
export const visibleSql = (column = 'project_id'): string =>
  `${column} IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active')`;
export const VISIBLE_PROJECT_SQL = visibleSql();

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** The role of this person in a workspace, if they are an active member. */
export function workspaceRole(db: Db, workspaceId: string, userId: string): string | null {
  const row = db.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .get(workspaceId, userId) as { role: string } | undefined;
  return row?.role ?? null;
}

/** A workspace the person belongs to, or not-found when they do not. */
export function requireWorkspace(db: Db, workspaceId: string, userId: string, admin = false): string {
  const workspace = db.prepare('SELECT is_deleted FROM workspaces WHERE id = ?').get(workspaceId) as { is_deleted: number } | undefined;
  const role = workspaceRole(db, workspaceId, userId);
  if (!workspace || workspace.is_deleted || !role) throw ApiFailure.notFound('That workspace does not exist.', 'WORKSPACE_NOT_FOUND');
  if (admin && role !== 'ADMIN') throw ApiFailure.forbidden('Only a workspace admin can do that.', 'WORKSPACE_ROLE_TOO_LOW');
  return role;
}
