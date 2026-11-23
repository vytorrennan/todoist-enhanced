import type { Db } from './db';
import { currentSeq } from './db';
import type { UserRow } from './auth';
import { VISIBLE_PROJECT_SQL, visibleSql } from './access';
import type { ReminderRow } from './reminders';
import { reminderApiShape } from './rest-shapes';
import {
  collaboratorOut, filterOut, folderOut, labelOut, type ItemRow, itemOut, noteOut, type NoteRow, projectOut, type ProjectRow,
  sectionOut, userOut, workspaceOut, bool,
} from './serialize';

/**
 * Reading: what a person can see, and what has changed since they last looked.
 *
 * A full read (token `*`, or a person whose access has changed since their
 * last read) returns everything they can see that is still open. An
 * incremental read returns every row changed after the token, deleted rows
 * included, so the client can take them away. Each row is visible only through
 * the viewer's own membership, which is why a read never needs to be told who
 * is asking twice.
 */

export const RESOURCE_TYPES = [
  'items', 'projects', 'sections', 'labels', 'notes', 'project_notes', 'reminders', 'user', 'collaborators',
  'workspaces', 'live_notifications', 'filters', 'completed_info', 'collaborator_states', 'folders', 'user_settings',
] as const;

export interface ReadResult {
  full_sync: boolean;
  sync_token: string;
  data: Record<string, unknown>;
}

/**
 * The open tasks a person can see, and everything under them, however deep. A checked subtask is part of its open
 * task's checklist and keeps its comments, so a full read sends it with the task it belongs to. Items and notes use
 * this one set, so they cannot disagree about what is shown.
 */
const OPEN_TREE_SQL = `WITH RECURSIVE tree(id) AS (
    SELECT id FROM items WHERE checked = 0 AND is_deleted = 0 AND ${VISIBLE_PROJECT_SQL}
    UNION
    SELECT c.id FROM items c JOIN tree t ON c.parent_id = t.id WHERE c.is_deleted = 0
  )`;

const chunks = <T>(list: T[], size = 500): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
};

/** How many live comments each of these items has. */
function noteCounts(db: Db, itemIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const part of chunks(itemIds)) {
    const marks = part.map(() => '?').join(',');
    const rows = db.prepare(`SELECT item_id, COUNT(*) AS n FROM notes WHERE is_deleted = 0 AND item_id IN (${marks}) GROUP BY item_id`)
      .all(...part) as Array<{ item_id: string; n: number }>;
    for (const row of rows) counts.set(row.item_id, row.n);
  }
  return counts;
}

export function readFor(db: Db, viewer: UserRow, since: number | null, types: readonly string[] | null): ReadResult {
  const wanted = new Set(types && types.length ? types : RESOURCE_TYPES);
  // A read is full when there is no token, or the token predates a change to what this person can see.
  const full = since === null || since < viewer.access_seq;
  const s = full ? 0 : since;
  const params = { viewer: viewer.id, since: s };
  const data: Record<string, unknown> = {};
  const want = (name: string) => wanted.has(name);

  if (want('items')) {
    const rows = full
      ? db.prepare(`${OPEN_TREE_SQL} SELECT * FROM items WHERE is_deleted = 0 AND ${VISIBLE_PROJECT_SQL} AND id IN (SELECT id FROM tree)`).all(params) as ItemRow[]
      : db.prepare(`SELECT * FROM items WHERE seq > @since AND ${VISIBLE_PROJECT_SQL}`).all(params) as ItemRow[];
    const counts = noteCounts(db, rows.filter((row) => !bool(row.is_deleted)).map((row) => row.id));
    data.items = rows.map((row) => itemOut(row, counts.get(row.id) ?? 0));
  }

  if (want('projects')) {
    const select = `SELECT p.id, p.name, p.description, p.color, p.parent_id, p.workspace_id, p.folder_id, p.view_style,
        p.is_inbox, p.is_archived, p.archived_at, p.is_deleted, p.access_visibility, p.created_at, p.seq,
        m.role, m.is_favorite, m.collapsed, m.child_order, m.order_key,
        (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id AND x.state = 'active') AS shared_count
      FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = @viewer AND m.state = 'active'`;
    const rows = full
      ? db.prepare(`${select} WHERE p.is_deleted = 0`).all(params) as ProjectRow[]
      : db.prepare(`${select} WHERE p.seq > @since OR m.seq > @since`).all(params) as ProjectRow[];
    data.projects = rows.map(projectOut);
  }

  if (want('sections')) {
    const rows = full
      ? db.prepare(`SELECT * FROM sections WHERE is_deleted = 0 AND ${VISIBLE_PROJECT_SQL}`).all(params)
      : db.prepare(`SELECT * FROM sections WHERE seq > @since AND ${VISIBLE_PROJECT_SQL}`).all(params);
    data.sections = (rows as Parameters<typeof sectionOut>[0][]).map(sectionOut);
  }

  if (want('reminders')) {
    // A removal is sent for a reminder whose task went away, so a device drops it; a live one needs a live task the person sees.
    const rows = db.prepare(`SELECT r.*, i.project_id AS project_id FROM reminders r JOIN items i ON i.id = r.item_id
      WHERE ${full ? 'r.is_deleted = 0 AND i.is_deleted = 0' : 'r.seq > @since'}
      AND (r.is_deleted = 1 OR (i.is_deleted = 0 AND ${visibleSql('i.project_id')}))
      AND (r.user_id = @viewer OR r.notify_uid = @viewer)`).all(params) as Array<ReminderRow & { project_id: string }>;
    data.reminders = rows.map((row) => (row.is_deleted ? { id: row.id, item_id: row.item_id, is_deleted: true } : reminderApiShape(row)));
  }

  if (want('labels')) {
    const rows = full
      ? db.prepare('SELECT * FROM labels WHERE user_id = @viewer AND is_deleted = 0').all(params)
      : db.prepare('SELECT * FROM labels WHERE user_id = @viewer AND seq > @since').all(params);
    data.labels = (rows as Parameters<typeof labelOut>[0][]).map(labelOut);
  }

  if (want('filters')) {
    const rows = full
      ? db.prepare('SELECT * FROM filters WHERE user_id = @viewer AND is_deleted = 0').all(params)
      : db.prepare('SELECT * FROM filters WHERE user_id = @viewer AND seq > @since').all(params);
    data.filters = (rows as Parameters<typeof filterOut>[0][]).map(filterOut);
  }

  if (want('notes') || want('project_notes')) {
    if (want('notes')) {
      const rows = full
        ? db.prepare(`${OPEN_TREE_SQL} SELECT n.* FROM notes n JOIN items i ON i.id = n.item_id
            WHERE n.is_deleted = 0 AND i.is_deleted = 0 AND i.id IN (SELECT id FROM tree) AND ${visibleSql('i.project_id')}`).all(params)
        : db.prepare(`SELECT n.* FROM notes n JOIN items i ON i.id = n.item_id
            WHERE n.seq > @since AND ${visibleSql('i.project_id')}`).all(params);
      data.notes = (rows as NoteRow[]).map((row) => noteOut(db, row));
    }
    if (want('project_notes')) {
      const rows = full
        ? db.prepare(`SELECT * FROM notes WHERE item_id IS NULL AND is_deleted = 0 AND ${VISIBLE_PROJECT_SQL}`).all(params)
        : db.prepare(`SELECT * FROM notes WHERE item_id IS NULL AND seq > @since AND ${VISIBLE_PROJECT_SQL}`).all(params);
      data.project_notes = (rows as NoteRow[]).map((row) => noteOut(db, row));
    }
  }

  if (want('user')) {
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id) as UserRow;
    if (full || fresh.seq > s) data.user = userOut(fresh);
  }

  if (want('collaborators')) {
    const sharing = `u.id = @viewer OR u.id IN (
        SELECT pm.user_id FROM project_members pm
        WHERE pm.state = 'active' AND pm.project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active')
        UNION
        SELECT wm.user_id FROM workspace_members wm
        WHERE wm.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = @viewer)
      )`;
    const rows = full
      ? db.prepare(`SELECT u.* FROM users u WHERE ${sharing}`).all(params)
      : db.prepare(`SELECT u.* FROM users u WHERE u.seq > @since AND (${sharing})`).all(params);
    data.collaborators = (rows as UserRow[]).map(collaboratorOut);
  }

  if (want('collaborator_states')) {
    const rows = full
      ? db.prepare(`SELECT project_id, user_id, state, role FROM project_members
          WHERE state IN ('active', 'invited') AND ${VISIBLE_PROJECT_SQL}`).all(params)
      : db.prepare(`SELECT project_id, user_id, state, role FROM project_members
          WHERE seq > @since AND ${VISIBLE_PROJECT_SQL}`).all(params);
    /* A removed membership is sent once as deleted, so the people list drops it. */
    data.collaborator_states = (rows as Array<{ project_id: string; user_id: string; state: string; role: string }>).map((row) => ({
      project_id: row.project_id,
      user_id: row.user_id,
      state: row.state,
      role: row.role,
      is_deleted: row.state === 'removed',
    }));
  }

  if (want('workspaces')) {
    // The person's own role comes with the workspace: it decides what the settings may offer them.
    const select = `SELECT w.*, m.role AS role FROM workspaces w
        JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = @viewer`;
    const rows = full
      ? db.prepare(`${select} WHERE w.is_deleted = 0`).all(params)
      : db.prepare(`${select} WHERE w.seq > @since`).all(params);
    data.workspaces = (rows as Parameters<typeof workspaceOut>[0][]).map(workspaceOut);
  }

  if (want('folders')) {
    const select = 'SELECT f.* FROM folders f WHERE f.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = @viewer)';
    const rows = full
      ? db.prepare(`${select} AND f.is_deleted = 0`).all(params)
      : db.prepare(`${select} AND f.seq > @since`).all(params);
    data.folders = (rows as Parameters<typeof folderOut>[0][]).map(folderOut);
  }

  if (want('live_notifications')) {
    const rows = full
      ? db.prepare('SELECT * FROM notifications WHERE user_id = @viewer AND is_deleted = 0 ORDER BY seq DESC LIMIT 500').all(params)
      : db.prepare('SELECT * FROM notifications WHERE user_id = @viewer AND seq > @since ORDER BY seq DESC LIMIT 500').all(params);
    data.live_notifications = (rows as Array<{ id: string; type: string; data: string; is_unread: number; is_deleted: number; created_at: string }>)
      .map((row) => ({
        ...(JSON.parse(row.data) as Record<string, unknown>),
        id: row.id,
        notification_type: row.type,
        created_at: row.created_at,
        is_unread: bool(row.is_unread),
        is_deleted: bool(row.is_deleted),
      }));
  }

  if (want('completed_info')) {
    const rows = db.prepare(`SELECT project_id, COUNT(*) AS completed_items FROM completions
        WHERE recurring = 0 AND project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active')
        GROUP BY project_id`).all(params) as Array<{ project_id: string; completed_items: number }>;
    data.completed_info = rows.map((row) => ({ project_id: row.project_id, completed_items: row.completed_items }));
  }

  if (want('user_settings')) {
    data.user_settings = { reset_recurring_subtasks: bool(viewer.reset_recurring_subtasks) };
  }

  return { full_sync: full, sync_token: `${viewer.id}:${currentSeq(db)}`, data };
}
