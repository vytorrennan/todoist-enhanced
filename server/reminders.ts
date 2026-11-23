import { ApiFailure, type Db, newId, nextSeq } from './db';
import { activeMembership, requireProject, visibleSql } from './access';
import { type Args, type Ctx, id as idArg, integer, resolveId, text, truthy } from './ctx';

/**
 * Reminders on tasks. A reminder is kept as it was set (an absolute one at a
 * due, a relative one a number of minutes before the task, or a location one);
 * delivering it is the client's business, as it is for the API.
 */

export interface ReminderRow {
  id: string;
  user_id: string;
  item_id: string;
  type: 'absolute' | 'relative';
  minute_offset: number | null;
  due: string | null;
  notify_uid: string;
  service: string | null;
  is_urgent: number;
  is_deleted: number;
  seq: number;
}

export interface LocationReminderRow {
  id: string;
  user_id: string;
  item_id: string;
  name: string;
  loc_lat: string;
  loc_long: string;
  loc_trigger: 'on_enter' | 'on_leave';
  radius: number;
  notify_uid: string;
  is_deleted: number;
  seq: number;
}

const DUE_FIELDS = ['date', 'string', 'timezone', 'lang', 'is_recurring'] as const;

/** A reminder is the business of the person who set it and the person it is for. */
const OWN = '(r.user_id = @viewer OR r.notify_uid = @viewer)';

/** The person a reminder is for: the viewer, or someone who is an active member of the task's project. */
function notifyOf(ctx: Ctx, project: string, value: unknown): string {
  if (typeof value !== 'string' || value === '' || value === ctx.viewer.id) return ctx.viewer.id;
  if (!activeMembership(ctx.db, project, value)) throw ApiFailure.badRequest('That person is not in this project.', 'NOT_A_MEMBER');
  return value;
}

/** The due a reminder is set at: the day, or the day and time, as the API sends it. */
function dueArg(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw ApiFailure.badRequest('An absolute reminder needs its due.', 'INVALID_ARGUMENT');
  const source = value as Record<string, unknown>;
  const date = typeof source.date === 'string' ? source.date : '';
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(date)) {
    throw ApiFailure.badRequest('A reminder needs the date it is due on.', 'INVALID_DATE');
  }
  const due: Record<string, unknown> = { date, string: typeof source.string === 'string' ? source.string : date.slice(0, 10) };
  for (const key of DUE_FIELDS) if (key in source && key !== 'date' && key !== 'string') due[key] = source[key];
  return due;
}

function taskProject(ctx: Ctx, itemId: string): string {
  const row = ctx.db.prepare('SELECT project_id FROM items WHERE id = ? AND is_deleted = 0').get(itemId) as { project_id: string } | undefined;
  if (!row) throw ApiFailure.notFound('That task does not exist.', 'ITEM_NOT_FOUND');
  requireProject(ctx.db, row.project_id, ctx.viewer.id, 'write');
  return row.project_id;
}

function reminderRow(ctx: Ctx, id: string): ReminderRow {
  const row = ctx.db.prepare(`SELECT r.* FROM reminders r JOIN items i ON i.id = r.item_id
    WHERE r.id = @id AND r.is_deleted = 0 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')} AND ${OWN}`)
    .get({ id, viewer: ctx.viewer.id }) as ReminderRow | undefined;
  if (!row) throw ApiFailure.notFound('That reminder does not exist.', 'REMINDER_NOT_FOUND');
  return row;
}

function locationRow(ctx: Ctx, id: string): LocationReminderRow {
  const row = ctx.db.prepare(`SELECT r.* FROM location_reminders r JOIN items i ON i.id = r.item_id
    WHERE r.id = @id AND r.is_deleted = 0 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')} AND ${OWN}`)
    .get({ id, viewer: ctx.viewer.id }) as LocationReminderRow | undefined;
  if (!row) throw ApiFailure.notFound('That location reminder does not exist.', 'REMINDER_NOT_FOUND');
  return row;
}

function reminderType(value: unknown): 'absolute' | 'relative' {
  if (value === undefined || value === 'relative') return 'relative';
  if (value === 'absolute') return 'absolute';
  throw ApiFailure.badRequest('A reminder is relative or absolute.', 'INVALID_ARGUMENT');
}

export function addReminder(ctx: Ctx, args: Args, tempId?: string): void {
  const itemId = resolveId(ctx, idArg(args, 'item_id', true));
  taskProject(ctx, itemId);
  const type = reminderType(args.type);
  const minute = type === 'relative' ? integer(args, 'minute_offset') : undefined;
  if (type === 'relative' && minute === undefined) throw ApiFailure.badRequest('A relative reminder needs its minutes.', 'INVALID_ARGUMENT');
  const due = type === 'absolute' ? JSON.stringify(dueArg(args.due)) : null;
  const notify = notifyOf(ctx, taskProject(ctx, itemId), args.notify_uid);
  const id = newId();
  ctx.db.prepare(`INSERT INTO reminders (id, user_id, item_id, type, minute_offset, due, notify_uid, service, is_urgent, is_deleted, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(id, ctx.viewer.id, itemId, type, minute ?? null, due, notify,
      typeof args.service === 'string' ? args.service : null, truthy(args.is_urgent) ? 1 : 0, nextSeq(ctx.db));
  if (tempId) ctx.temps.set(tempId, id);
}

export function updateReminder(ctx: Ctx, args: Args): void {
  const row = reminderRow(ctx, resolveId(ctx, idArg(args, 'id', true)));
  taskProject(ctx, row.item_id);
  const set: Record<string, unknown> = {};
  if ('minute_offset' in args) {
    if (row.type !== 'relative') throw ApiFailure.badRequest('Only a relative reminder has minutes.', 'INVALID_ARGUMENT');
    const minute = integer(args, 'minute_offset');
    if (minute === undefined) throw ApiFailure.badRequest('A relative reminder needs its minutes.', 'INVALID_ARGUMENT');
    set.minute_offset = minute;
  }
  if ('due' in args) {
    if (row.type !== 'absolute') throw ApiFailure.badRequest('Only an absolute reminder has a due.', 'INVALID_ARGUMENT');
    set.due = JSON.stringify(dueArg(args.due));
  }
  if (typeof args.notify_uid === 'string') set.notify_uid = notifyOf(ctx, taskProject(ctx, row.item_id), args.notify_uid);
  if (typeof args.service === 'string') set.service = args.service;
  if ('is_urgent' in args) set.is_urgent = truthy(args.is_urgent) ? 1 : 0;
  const keys = Object.keys(set);
  if (keys.length === 0) return;
  ctx.db.prepare(`UPDATE reminders SET ${keys.map((key) => `${key} = @${key}`).join(', ')}, seq = @seq WHERE id = @id`)
    .run({ ...set, seq: nextSeq(ctx.db), id: row.id });
}

export function deleteReminder(ctx: Ctx, args: Args): void {
  const row = reminderRow(ctx, resolveId(ctx, idArg(args, 'id', true)));
  taskProject(ctx, row.item_id);
  ctx.db.prepare('UPDATE reminders SET is_deleted = 1, seq = ? WHERE id = ?').run(nextSeq(ctx.db), row.id);
}

export function addLocationReminder(ctx: Ctx, args: Args, tempId?: string): void {
  const itemId = resolveId(ctx, idArg(args, 'item_id', true));
  taskProject(ctx, itemId);
  const name = text(args, 'name', { required: true, max: 200 }) ?? '';
  const lat = text(args, 'loc_lat', { required: true, max: 32 }) ?? '';
  const long = text(args, 'loc_long', { required: true, max: 32 }) ?? '';
  const trigger = args.loc_trigger === 'on_leave' ? 'on_leave' : 'on_enter';
  const notify = notifyOf(ctx, taskProject(ctx, itemId), args.notify_uid);
  if (args.loc_trigger !== undefined && args.loc_trigger !== 'on_enter' && args.loc_trigger !== 'on_leave') {
    throw ApiFailure.badRequest('A location reminder fires on_enter or on_leave.', 'INVALID_ARGUMENT');
  }
  const id = newId();
  ctx.db.prepare(`INSERT INTO location_reminders (id, user_id, item_id, name, loc_lat, loc_long, loc_trigger, radius, notify_uid, is_deleted, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(id, ctx.viewer.id, itemId, name, lat, long, trigger, integer(args, 'radius', { min: 0 }) ?? 100, notify, nextSeq(ctx.db));
  if (tempId) ctx.temps.set(tempId, id);
}

export function updateLocationReminder(ctx: Ctx, args: Args): void {
  const row = locationRow(ctx, resolveId(ctx, idArg(args, 'id', true)));
  taskProject(ctx, row.item_id);
  const set: Record<string, unknown> = {};
  if (typeof args.name === 'string') set.name = args.name.slice(0, 200);
  if (typeof args.loc_lat === 'string') set.loc_lat = args.loc_lat;
  if (typeof args.loc_long === 'string') set.loc_long = args.loc_long;
  if (args.loc_trigger === 'on_enter' || args.loc_trigger === 'on_leave') set.loc_trigger = args.loc_trigger;
  if ('radius' in args) {
    const radius = integer(args, 'radius', { min: 0 });
    if (radius === undefined) throw ApiFailure.badRequest('A radius is a whole number of metres.', 'INVALID_ARGUMENT');
    set.radius = radius;
  }
  if (typeof args.notify_uid === 'string') set.notify_uid = notifyOf(ctx, taskProject(ctx, row.item_id), args.notify_uid);
  const keys = Object.keys(set);
  if (keys.length === 0) return;
  ctx.db.prepare(`UPDATE location_reminders SET ${keys.map((key) => `${key} = @${key}`).join(', ')}, seq = @seq WHERE id = @id`)
    .run({ ...set, seq: nextSeq(ctx.db), id: row.id });
}

export function deleteLocationReminder(ctx: Ctx, args: Args): void {
  const row = locationRow(ctx, resolveId(ctx, idArg(args, 'id', true)));
  taskProject(ctx, row.item_id);
  ctx.db.prepare('UPDATE location_reminders SET is_deleted = 1, seq = ? WHERE id = ?').run(nextSeq(ctx.db), row.id);
}

export const REMINDER_COMMANDS = {
  reminder_add: (ctx: Ctx, args: Args, temp?: string) => addReminder(ctx, args, temp),
  reminder_update: (ctx: Ctx, args: Args) => updateReminder(ctx, args),
  reminder_delete: (ctx: Ctx, args: Args) => deleteReminder(ctx, args),
  location_reminder_add: (ctx: Ctx, args: Args, temp?: string) => addLocationReminder(ctx, args, temp),
  location_reminder_update: (ctx: Ctx, args: Args) => updateLocationReminder(ctx, args),
  location_reminder_delete: (ctx: Ctx, args: Args) => deleteLocationReminder(ctx, args),
};

/** The reminders a person can see, on tasks they can see, as the API lists them. */
export function reminderList(db: Db, viewerId: string): Array<ReminderRow & { project_id: string }> {
  return db.prepare(`SELECT r.*, i.project_id AS project_id FROM reminders r JOIN items i ON i.id = r.item_id
    WHERE r.is_deleted = 0 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')} AND ${OWN} ORDER BY r.seq`)
    .all({ viewer: viewerId }) as Array<ReminderRow & { project_id: string }>;
}

export function locationReminderList(db: Db, viewerId: string): Array<LocationReminderRow & { project_id: string }> {
  return db.prepare(`SELECT r.*, i.project_id AS project_id FROM location_reminders r JOIN items i ON i.id = r.item_id
    WHERE r.is_deleted = 0 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')} AND ${OWN} ORDER BY r.seq`)
    .all({ viewer: viewerId }) as Array<LocationReminderRow & { project_id: string }>;
}

/** One reminder a person can see, with its project, or null. */
export function visibleReminder(db: Db, viewerId: string, id: string): (ReminderRow & { project_id: string }) | null {
  return (db.prepare(`SELECT r.*, i.project_id AS project_id FROM reminders r JOIN items i ON i.id = r.item_id
    WHERE r.id = @id AND r.is_deleted = 0 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')} AND ${OWN}`)
    .get({ id, viewer: viewerId }) as (ReminderRow & { project_id: string }) | undefined) ?? null;
}

export function visibleLocationReminder(db: Db, viewerId: string, id: string): (LocationReminderRow & { project_id: string }) | null {
  return (db.prepare(`SELECT r.*, i.project_id AS project_id FROM location_reminders r JOIN items i ON i.id = r.item_id
    WHERE r.id = @id AND r.is_deleted = 0 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')} AND ${OWN}`)
    .get({ id, viewer: viewerId }) as (LocationReminderRow & { project_id: string }) | undefined) ?? null;
}
