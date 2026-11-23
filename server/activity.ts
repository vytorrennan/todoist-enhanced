import type { Db } from './db';
import { nowIso } from './db';
import type { UserRow } from './auth';
import { visibleSql } from './access';

/**
 * The activity log: one event for each change a command made, kept with the
 * project it happened in. The events are written by the command engine, so a
 * change made through sync and one made through REST are logged alike.
 */

const EVENTS: Record<string, string> = {
  add: 'added', update: 'updated', delete: 'deleted', complete: 'completed', close: 'completed',
  uncomplete: 'uncompleted', archive: 'archived', unarchive: 'unarchived', move: 'moved',
  move_to_workspace: 'moved', move_to_personal: 'moved',
};

const OBJECTS: Record<string, string> = {
  item: 'item', project: 'project', section: 'section', note: 'comment', label: 'label', filter: 'filter',
  folder: 'folder', reminder: 'reminder', location_reminder: 'location_reminder', workspace: 'workspace',
};

/** Which object and event a command describes, or null for a command that changes no single object. */
export function describe(type: string): { object: string; event: string } | null {
  if (type.endsWith('_update_orders') || type.endsWith('_update_day_orders') || type.endsWith('_reorder') || type === 'live_notifications_mark_read') return null;
  const object = Object.keys(OBJECTS).sort((a, b) => b.length - a.length).find((key) => type === key || type.startsWith(`${key}_`));
  if (!object) return null;
  const verb = type.slice(object.length + 1);
  const event = EVENTS[verb];
  return event ? { object: OBJECTS[object], event } : null;
}

/** The project and task an object sits in now, read back from the database. */
function placeOf(db: Db, object: string, id: string): { project: string | null; item: string | null } {
  if (object === 'item') {
    const row = db.prepare('SELECT project_id FROM items WHERE id = ?').get(id) as { project_id: string } | undefined;
    return { project: row?.project_id ?? null, item: id };
  }
  if (object === 'project') return { project: id, item: null };
  if (object === 'section') {
    const row = db.prepare('SELECT project_id FROM sections WHERE id = ?').get(id) as { project_id: string } | undefined;
    return { project: row?.project_id ?? null, item: null };
  }
  if (object === 'comment') {
    const row = db.prepare('SELECT item_id, project_id FROM notes WHERE id = ?').get(id) as { item_id: string | null; project_id: string | null } | undefined;
    if (!row) return { project: null, item: null };
    if (row.item_id) {
      const parent = db.prepare('SELECT project_id FROM items WHERE id = ?').get(row.item_id) as { project_id: string } | undefined;
      return { project: parent?.project_id ?? null, item: row.item_id };
    }
    return { project: row.project_id, item: null };
  }
  return { project: null, item: null };
}

/** Records the event a successful command made. `id` is the object the command changed. */
export function recordActivity(db: Db, viewer: UserRow, type: string, id: string | undefined, now = nowIso()): void {
  const what = describe(type);
  if (!what || !id) return;
  const place = placeOf(db, what.object, id);
  db.prepare(`INSERT INTO activity_events (user_id, object_type, object_id, event_type, event_date, parent_project_id, parent_item_id, extra_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(viewer.id, what.object, id, what.event, now, place.project, place.item);
}

export interface ActivityFilter {
  object_type?: string | null;
  object_id?: string | null;
  event_type?: string | null;
  parent_project_id?: string | null;
  parent_item_id?: string | null;
  initiator_id?: string | null;
}

/** Events the person may see: those of projects they can see, and their own events with no project. */
export function listActivity(db: Db, viewer: UserRow, filter: ActivityFilter, cursor: number, limit: number) {
  // Newest first, as the API lists it: a page is the events before the last one of the page before.
  const where = [`(e.parent_project_id IS NULL AND e.user_id = @viewer OR e.parent_project_id IS NOT NULL AND ${visibleSql('e.parent_project_id')})`, 'e.id < @cursor'];
  const params: Record<string, unknown> = { viewer: viewer.id, cursor };
  const exact: Array<[keyof ActivityFilter, string]> = [
    ['object_type', 'e.object_type'], ['object_id', 'e.object_id'], ['event_type', 'e.event_type'],
    ['parent_project_id', 'e.parent_project_id'], ['parent_item_id', 'e.parent_item_id'], ['initiator_id', 'e.user_id'],
  ];
  for (const [key, column] of exact) {
    const value = filter[key];
    if (value) { where.push(`${column} = @${key}`); params[key] = value; }
  }
  const rows = db.prepare(`SELECT e.* FROM activity_events e WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT @limit`)
    .all({ ...params, limit: limit + 1 }) as Array<{ id: number; user_id: string; object_type: string; object_id: string; event_type: string; event_date: string; parent_project_id: string | null; parent_item_id: string | null; extra_data: string | null }>;
  const page = rows.slice(0, limit);
  return {
    results: page.map((row) => ({
      id: String(row.id),
      object_type: row.object_type,
      object_id: row.object_id,
      event_type: row.event_type,
      event_date: row.event_date,
      parent_project_id: row.parent_project_id,
      parent_item_id: row.parent_item_id,
      initiator_id: row.user_id,
      extra_data: row.extra_data ? (JSON.parse(row.extra_data) as Record<string, unknown>) : null,
    })),
    next_cursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  };
}
