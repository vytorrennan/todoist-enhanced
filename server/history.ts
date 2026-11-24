import { ApiFailure, type Db } from './db';
import { VISIBLE_PROJECT_SQL } from './access';
import { type ItemRow, itemOut, parseLabels } from './serialize';

/** The completed-task history, and reading one task (open or done). */

export interface HistoryQuery {
  since?: string;
  until?: string;
  limit?: string;
  cursor?: string;
  offset?: string;
  project_id?: string;
}

function instant(raw: string | undefined, fallback: string): string {
  const value = raw ?? fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw ApiFailure.badRequest('The date range is not a date.', 'INVALID_DATE');
  return new Date(time).toISOString();
}

function window(query: HistoryQuery): { since: string; until: string; limit: number } {
  const since = instant(query.since, '1970-01-01T00:00:00Z');
  const until = instant(query.until, '9999-12-31T23:59:59Z');
  if (since > until) throw ApiFailure.badRequest('The range starts after it ends.', 'INVALID_DATE');
  const limit = Math.min(Math.max(Number(query.limit ?? 200) || 200, 1), 500);
  return { since, until, limit };
}

interface CompletionRow {
  id: string;
  item_id: string;
  user_id: string;
  project_id: string;
  section_id: string | null;
  content: string;
  completed_at: string;
  recurring: number;
  labels: string;
  duration_amount: number | null;
  duration_unit: string | null;
  priority: number;
  responsible_uid: string | null;
  parent_id: string | null;
}

const durationOf = (row: CompletionRow) => (row.duration_amount !== null && row.duration_unit
  ? { amount: row.duration_amount, unit: row.duration_unit } : null);

/** Ordinary completions only: a repeating task's occurrences are read through `completedTasks`. */
export function completedByDate(db: Db, viewerId: string, query: HistoryQuery) {
  const { since, until, limit } = window(query);
  const offset = Math.max(0, Number(query.cursor ?? 0) || 0);
  const scope = query.project_id ? 'AND c.project_id = @scope' : '';
  const rows = db.prepare(`SELECT c.* FROM completions c
      WHERE c.recurring = 0 AND c.completed_at >= @since AND c.completed_at <= @until
        AND c.project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active') ${scope}
      ORDER BY c.completed_at DESC, c.id LIMIT @limit OFFSET @offset`)
    .all({ viewer: viewerId, since, until, limit: limit + 1, offset, scope: query.project_id ?? null }) as CompletionRow[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.item_id,
      task_id: row.item_id,
      user_id: row.user_id,
      project_id: row.project_id,
      section_id: row.section_id,
      content: row.content,
      completed_at: row.completed_at,
      labels: parseLabels(row.labels),
      duration: durationOf(row),
      priority: row.priority,
      note_count: 0,
      responsible_uid: row.responsible_uid,
    })),
    next_cursor: more ? String(offset + limit) : null,
  };
}

/** Every completion, repeats included, one entry each, with the task it belongs to. */
export function completedTasks(db: Db, viewerId: string, query: HistoryQuery) {
  const { since, until, limit } = window(query);
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  const scope = query.project_id ? 'AND c.project_id = @scope' : '';
  const rows = db.prepare(`SELECT c.* FROM completions c
      WHERE c.completed_at >= @since AND c.completed_at <= @until
        AND c.project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active') ${scope}
      ORDER BY c.completed_at DESC, c.id LIMIT @limit OFFSET @offset`)
    .all({ viewer: viewerId, since, until, limit, offset, scope: query.project_id ?? null }) as CompletionRow[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      task_id: row.item_id,
      user_id: row.user_id,
      project_id: row.project_id,
      section_id: row.section_id,
      content: row.content,
      completed_at: row.completed_at,
      note_count: 0,
      item_object: {
        labels: parseLabels(row.labels),
        duration: durationOf(row),
        priority: row.priority,
        responsible_uid: row.responsible_uid,
        parent_id: row.parent_id,
        due: { is_recurring: row.recurring === 1 },
      },
    })),
    next_cursor: null,
  };
}

/** One task, whether it is open or done. Deleted tasks are not found. */
export function readTask(db: Db, viewerId: string, taskId: string) {
  const row = db.prepare(`SELECT * FROM items WHERE id = @id AND is_deleted = 0 AND ${VISIBLE_PROJECT_SQL}`)
    .get({ id: taskId, viewer: viewerId }) as ItemRow | undefined;
  if (!row) throw ApiFailure.notFound('That task does not exist.', 'ITEM_NOT_FOUND');
  const notes = (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE item_id = ? AND is_deleted = 0').get(row.id) as { n: number }).n;
  return itemOut(row, notes);
}
