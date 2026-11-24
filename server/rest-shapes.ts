import type { Db } from './db';
import type { UserRow } from './auth';
import { bool, folderOut, itemOut, labelOut, noteOut, sectionOut, timezoneOffsetMinutes, userOut, workspaceOut, type ItemRow, type NoteRow, type ProjectRow } from './serialize';

/**
 * The shapes the official REST API v1 returns, which the official SDK and MCP
 * read. Each function takes one of this server's rows and returns the object
 * the API documents; the field names are the API's own, in snake_case.
 */

const DEFAULT_LANG = 'en';

export function taskShape(row: ItemRow, noteCount = 0) {
  const base = itemOut(row, noteCount);
  return {
    ...base,
    user_id: row.added_by ?? '',
    added_by_uid: row.added_by ?? null,
    assigned_by_uid: null,
    responsible_uid: row.responsible_uid ?? null,
    due: row.due_date
      ? {
          date: row.due_date.slice(0, 10),
          datetime: row.due_date.includes('T') ? row.due_date : null,
          string: row.due_string ?? row.due_date.slice(0, 10),
          lang: row.due_lang ?? DEFAULT_LANG,
          is_recurring: bool(row.due_recurring),
          timezone: row.due_timezone ?? null,
        }
      : null,
    deadline: row.deadline_date ? { date: row.deadline_date.slice(0, 10), lang: row.deadline_lang ?? DEFAULT_LANG } : null,
    duration: row.duration_amount !== null && row.duration_unit ? { amount: row.duration_amount, unit: row.duration_unit } : null,
    is_uncompletable: false,
  };
}

/** A project as the API returns it: a workspace project names its workspace, a personal one carries no such key. */
export function projectShape(row: ProjectRow) {
  const created = row.created_at ?? null;
  const base = {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: null,
    child_order: row.child_order,
    order_key: row.order_key,
    default_order: row.child_order,
    default_order_key: row.order_key,
    can_assign_tasks: row.role !== 'READ_ONLY',
    is_archived: bool(row.is_archived),
    is_deleted: bool(row.is_deleted),
    is_favorite: bool(row.is_favorite),
    is_frozen: false,
    is_collapsed: bool(row.collapsed),
    is_shared: row.shared_count > 1,
    created_at: created,
    updated_at: created,
    view_style: row.view_style,
    url: `https://todoist.com/app/project/${row.id}`,
  };
  if (row.workspace_id) {
    return {
      ...base,
      workspace_id: row.workspace_id,
      folder_id: row.folder_id,
      role: row.role,
      status: row.is_archived ? 'archived' : 'active',
      collaborator_role_default: 'READ_ONLY',
      is_invite_only: false,
      is_link_sharing_enabled: false,
      access: { visibility: row.access_visibility },
      public_access: row.access_visibility === 'public',
      public_key: '',
      is_pending_default_collaborator_invites: false,
    };
  }
  return { ...base, parent_id: row.parent_id, inbox_project: bool(row.is_inbox) };
}

type SectionRow = Parameters<typeof sectionOut>[0];

export function sectionShape(row: SectionRow, owner: string, since: string | null) {
  const base = sectionOut(row);
  return {
    id: base.id,
    user_id: owner,
    project_id: base.project_id,
    name: base.name,
    description: base.description ?? '',
    section_order: base.section_order,
    order_key: base.order_key,
    // Sections keep no timestamps of their own: the project's creation stands in for them.
    added_at: since,
    updated_at: since,
    archived_at: null,
    is_archived: base.is_archived,
    is_deleted: base.is_deleted,
    is_collapsed: base.collapsed,
    url: `https://todoist.com/app/section/${base.id}`,
  };
}

/** A reminder as the API returns it, by its type. */
export function reminderApiShape(row: { id: string; type: 'absolute' | 'relative'; minute_offset: number | null; due: string | null; notify_uid: string; item_id: string; project_id: string; is_urgent: number }) {
  const base = { id: row.id, notify_uid: row.notify_uid, item_id: row.item_id, project_id: row.project_id, is_deleted: false, type: row.type };
  if (row.type === 'absolute') {
    const due = JSON.parse(row.due ?? '{}') as Record<string, unknown>;
    return {
      ...base,
      due: { date: due.date, string: due.string ?? String(due.date ?? '').slice(0, 10), lang: due.lang ?? DEFAULT_LANG, is_recurring: bool(due.is_recurring as number), timezone: due.timezone ?? null },
      is_urgent: bool(row.is_urgent),
    };
  }
  return { ...base, minute_offset: row.minute_offset, is_urgent: bool(row.is_urgent) };
}

export function locationReminderApiShape(row: { id: string; name: string; loc_lat: string; loc_long: string; loc_trigger: string; radius: number; notify_uid: string; item_id: string; project_id: string }) {
  return {
    id: row.id, notify_uid: row.notify_uid, item_id: row.item_id, project_id: row.project_id, is_deleted: false,
    type: 'location', name: row.name, loc_lat: row.loc_lat, loc_long: row.loc_long, loc_trigger: row.loc_trigger, radius: row.radius,
  };
}

export function labelShape(row: Parameters<typeof labelOut>[0]) {
  const base = labelOut(row);
  return {
    id: base.id,
    name: base.name,
    color: base.color,
    order: row.item_order,
    is_favorite: base.is_favorite,
  };
}

/** A comment on a task or on a project: the API names the one it is on, and only that one. */
export function commentShape(db: Db, row: NoteRow) {
  const base = noteOut(db, row);
  const on = base.item_id ? { item_id: base.item_id } : { project_id: base.project_id ?? '' };
  return {
    id: base.id,
    ...on,
    content: base.content,
    posted_at: base.posted_at,
    posted_uid: base.posted_uid,
    is_deleted: base.is_deleted,
    file_attachment: base.file_attachment,
    uids_to_notify: [] as string[],
    reactions: base.reactions,
  };
}

export function folderShape(row: Parameters<typeof folderOut>[0]) {
  return { ...folderOut(row), default_order: row.child_order, default_order_key: null };
}

export function workspaceApiShape(row: Parameters<typeof workspaceOut>[0]) {
  const base = workspaceOut(row);
  return {
    id: base.id,
    name: base.name,
    plan: 'current_personal_plan',
    role: base.role,
    invite_code: '',
    is_link_sharing_enabled: false,
    is_guest_allowed: true,
    creator_id: '',
    properties: base.properties,
    is_archived: base.is_archived,
    is_deleted: base.is_deleted,
  };
}

export function collaboratorShape(user: { id: string; email: string; full_name: string; image_id: string | null; timezone: string }) {
  return { id: user.id, name: user.full_name, email: user.email, timezone: user.timezone, full_name: user.full_name, image_id: user.image_id, avatar_big: null };
}

export function userApiShape(user: UserRow) {
  const base = userOut(user);
  const offset = timezoneOffsetMinutes(user.timezone);
  const magnitude = Math.abs(offset);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    ...base,
    tz_info: {
      ...base.tz_info,
      gmt_string: `GMT${offset < 0 ? '-' : '+'}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`,
    },
    business_account_id: null,
    date_format: 0,
    time_format: 0,
    weekly_goal: 0,
    daily_goal: 0,
    completed_count: 0,
    completed_today: 0,
    karma: 0,
    karma_trend: 'stable',
    next_week: 1,
    start_day: user.start_day ?? 1,
    start_page: 'inbox',
    days_off: [6, 7],
    weekend_start_day: 6,
    premium_status: 'current_personal_plan',
    is_premium: true,
    avatar_big: null,
    inbox_project_id: user.inbox_project_id,
  };
}

export type { ProjectRow, ItemRow, NoteRow };
