import type { Db } from './db';
import type { UserRow } from './auth';

/**
 * Rows as the client reads them. The field names are the ones the app has
 * always used; the values come straight from the database.
 */

export const bool = (value: unknown): boolean => value === 1 || value === true;

export function parseLabels(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((label): label is string => typeof label === 'string') : [];
  } catch {
    return [];
  }
}

export interface ItemRow {
  id: string;
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  content: string;
  description: string;
  priority: number;
  due_date: string | null;
  due_string: string | null;
  due_lang: string | null;
  due_timezone: string | null;
  due_recurring: number;
  deadline_date: string | null;
  deadline_lang: string | null;
  duration_amount: number | null;
  duration_unit: string | null;
  labels: string;
  child_order: number;
  order_key: string | null;
  day_order: number;
  collapsed: number;
  checked: number;
  completed_at: string | null;
  is_deleted: number;
  added_by: string | null;
  added_at: string;
  updated_at: string;
  responsible_uid: string | null;
  seq: number;
}

export function itemOut(row: ItemRow, noteCount = 0) {
  return {
    id: row.id,
    user_id: row.added_by ?? '',
    project_id: row.project_id,
    section_id: row.section_id,
    parent_id: row.parent_id,
    content: row.content,
    description: row.description,
    priority: row.priority,
    due: row.due_date
      ? {
          date: row.due_date,
          timezone: row.due_timezone,
          string: row.due_string ?? row.due_date.slice(0, 10),
          lang: row.due_lang ?? 'en',
          is_recurring: bool(row.due_recurring),
        }
      : null,
    deadline: row.deadline_date ? { date: row.deadline_date.slice(0, 10), lang: row.deadline_lang ?? 'en' } : null,
    duration: row.duration_amount !== null && row.duration_unit
      ? { amount: row.duration_amount, unit: row.duration_unit }
      : null,
    labels: parseLabels(row.labels),
    child_order: row.child_order,
    order_key: row.order_key,
    day_order: row.day_order,
    collapsed: bool(row.collapsed),
    is_collapsed: bool(row.collapsed),
    checked: bool(row.checked),
    is_deleted: bool(row.is_deleted),
    added_at: row.added_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
    responsible_uid: row.responsible_uid,
    added_by_uid: row.added_by ?? null,
    assigned_by_uid: null,
    note_count: noteCount,
  };
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  color: string;
  parent_id: string | null;
  workspace_id: string | null;
  folder_id: string | null;
  view_style: string;
  is_inbox: number;
  is_archived: number;
  archived_at: string | null;
  is_deleted: number;
  access_visibility: string;
  created_at: string;
  seq: number;
  // membership (per viewer)
  role: string;
  is_favorite: number;
  collapsed: number;
  child_order: number;
  order_key: string | null;
  shared_count: number;
}

export function projectOut(row: ProjectRow) {
  const shared = row.shared_count > 1;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    parent_id: row.parent_id,
    child_order: row.child_order,
    order_key: row.order_key,
    is_archived: bool(row.is_archived),
    is_deleted: bool(row.is_deleted),
    is_favorite: bool(row.is_favorite),
    inbox_project: bool(row.is_inbox),
    view_style: row.view_style,
    workspace_id: row.workspace_id,
    access: { visibility: row.access_visibility },
    role: row.role,
    folder_id: row.folder_id,
    created_at: row.created_at,
    archived_date: row.archived_at ?? undefined,
    is_shared: shared,
    shared,
    can_assign_tasks: row.role !== 'READ_ONLY',
    collapsed: bool(row.collapsed),
    is_folder: false,
  };
}

export const sectionOut = (row: {
  id: string; project_id: string; name: string; description: string; section_order: number; order_key: string | null;
  is_archived: number; is_deleted: number; collapsed: number;
}) => ({
  id: row.id,
  project_id: row.project_id,
  name: row.name,
  description: row.description,
  section_order: row.section_order,
  order_key: row.order_key,
  is_archived: bool(row.is_archived),
  is_deleted: bool(row.is_deleted),
  collapsed: bool(row.collapsed),
});

export const labelOut = (row: {
  id: string; name: string; color: string; item_order: number; order_key: string | null; is_favorite: number; is_deleted: number;
}) => ({
  id: row.id,
  name: row.name,
  color: row.color,
  item_order: row.item_order,
  order_key: row.order_key,
  is_favorite: bool(row.is_favorite),
  is_deleted: bool(row.is_deleted),
});

export const filterOut = (row: {
  id: string; name: string; query: string; description: string; color: string; item_order: number; order_key: string | null;
  is_favorite: number; is_deleted: number;
}) => ({
  id: row.id,
  name: row.name,
  query: row.query,
  description: row.description,
  color: row.color,
  item_order: row.item_order,
  order_key: row.order_key,
  is_favorite: bool(row.is_favorite),
  is_deleted: bool(row.is_deleted),
  is_frozen: false,
});

export const workspaceOut = (row: { id: string; name: string; default_access_level: string; is_archived: number; is_deleted: number; role?: string }) => ({
  id: row.id,
  name: row.name,
  logo_big: null,
  properties: { default_access_level: row.default_access_level },
  is_archived: bool(row.is_archived),
  is_deleted: bool(row.is_deleted),
  role: row.role,
});

export const folderOut = (row: { id: string; workspace_id: string; name: string; child_order: number; is_deleted: number }) => ({
  id: row.id,
  name: row.name,
  workspace_id: row.workspace_id,
  child_order: row.child_order,
  is_deleted: bool(row.is_deleted),
});

export interface NoteRow {
  id: string;
  item_id: string | null;
  project_id: string | null;
  content: string;
  posted_at: string;
  posted_by: string;
  is_deleted: number;
  file_attachment: string | null;
}

export function noteOut(db: Db, row: NoteRow) {
  const reactionRows = db.prepare('SELECT emoji, user_id FROM note_reactions WHERE note_id = ? ORDER BY created_at, user_id')
    .all(row.id) as Array<{ emoji: string; user_id: string }>;
  let reactions: Record<string, string[]> | null = null;
  for (const { emoji, user_id } of reactionRows) {
    reactions ??= {};
    (reactions[emoji] ??= []).push(user_id);
  }
  return {
    id: row.id,
    item_id: row.item_id,
    project_id: row.project_id,
    content: row.content,
    posted_at: row.posted_at,
    posted_uid: row.posted_by,
    is_deleted: bool(row.is_deleted),
    file_attachment: row.file_attachment ? (JSON.parse(row.file_attachment) as unknown) : null,
    reactions,
  };
}

export function userOut(user: UserRow) {
  const offset = timezoneOffsetMinutes(user.timezone);
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    inbox_project_id: user.inbox_project_id,
    tz_info: {
      timezone: user.timezone,
      hours: Math.trunc(offset / 60),
      minutes: Math.abs(offset % 60),
      is_dst: 0,
    },
    start_day: user.start_day,
    premium_status: 'premium',
    is_premium: true,
    lang: user.lang,
    image_id: user.image_id,
    avatar_big: null,
    /* Karma is Todoist's own score. Nothing here computes one, so the sidebar leaves it out. */
    karma: null,
    karma_trend: null,
  };
}

export function collaboratorOut(user: { id: string; email: string; full_name: string; image_id: string | null }) {
  return { id: user.id, email: user.email, full_name: user.full_name, image_id: user.image_id, avatar_big: null };
}

/** The minutes a zone is ahead of UTC right now. */
export function timezoneOffsetMinutes(timezone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((local - now.getTime()) / 60_000);
  } catch {
    return 0;
  }
}
