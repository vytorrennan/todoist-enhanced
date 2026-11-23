import { ApiFailure, type Db, newId, nextSeq } from './db';
import { activeMembership, canBeAssigned, requireProject, visibleSql } from './access';
import { requireFullSyncFor } from './sharing';
import { type Args, type Ctx, endOfList, id as idArg, orderKeyArg, orderNumberArg, renumber, resolveId, text, truthy, wholeNumber } from './ctx';
import { advanceRecurring, resolveDue, type StoredDue } from './recurrence';
import { isDay } from './dates';
import { type ItemRow } from './serialize';

/** Tasks: creating, editing, ticking, closing, deleting, moving and ordering them. */

export const MAX_CONTENT = 2000;
export const MAX_DESCRIPTION = 20_000;
const MAX_LABELS = 100;

export function cleanLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw ApiFailure.badRequest('“labels” must be a list.');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw ApiFailure.badRequest('A label must be text.');
    const name = raw.trim().slice(0, 120);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (out.length > MAX_LABELS) throw ApiFailure.badRequest('A task can carry at most 100 labels.');
  return out;
}

export function cleanPriority(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'string' && /^\d$/.test(value) ? Number(value) : value;
  if (number !== 1 && number !== 2 && number !== 3 && number !== 4) throw ApiFailure.badRequest('“priority” must be 1 to 4.');
  return number;
}

function cleanDeadline(value: unknown): { date: string; lang: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw ApiFailure.badRequest('“deadline” must be a date.');
  const date = String((value as { date?: unknown }).date ?? '').slice(0, 10);
  if (!isDay(date)) throw ApiFailure.badRequest('A deadline needs a date.', 'INVALID_DATE');
  return { date, lang: String((value as { lang?: unknown }).lang ?? 'en') };
}

function cleanDuration(value: unknown): { amount: number; unit: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw ApiFailure.badRequest('“duration” must be an amount and a unit.');
  const amount = Number((value as { amount?: unknown }).amount);
  const unit = (value as { unit?: unknown }).unit;
  if (!Number.isInteger(amount) || amount < 1 || amount > 100_000) throw ApiFailure.badRequest('A duration must be a whole number above zero.', 'INVALID_DURATION');
  if (unit !== 'minute' && unit !== 'day') throw ApiFailure.badRequest('A duration unit is minute or day.', 'INVALID_DURATION');
  return { amount, unit };
}

const storedDue = (due: StoredDue | null) => ({
  due_date: due?.date ?? null,
  due_string: due?.string ?? null,
  due_lang: due?.lang ?? null,
  due_timezone: due?.timezone ?? null,
  due_recurring: due?.recurring ? 1 : 0,
});

/** A task the viewer can see, or not-found. Deleted tasks are not found. */
export function loadItem(ctx: Ctx, itemId: string): ItemRow {
  const row = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
  // A task in a project the person cannot see is, to them, a task that does not exist.
  if (!row || row.is_deleted || !activeMembership(ctx.db, row.project_id, ctx.viewer.id)) {
    throw ApiFailure.notFound('That task does not exist.', 'ITEM_NOT_FOUND');
  }
  return row;
}

/** The task and every task under it, the task itself first. */
export function subtreeIds(db: Db, rootId: string): string[] {
  const rows = db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM items WHERE id = ?
      UNION ALL
      SELECT items.id FROM items JOIN tree ON items.parent_id = tree.id
    ) SELECT id FROM tree`).all(rootId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function assertAssignee(ctx: Ctx, projectId: string, uid: unknown): string | null {
  if (uid === null || uid === undefined || uid === '') return null;
  if (typeof uid !== 'string') throw ApiFailure.badRequest('“responsible_uid” must be a person.');
  const member = ctx.db.prepare(`SELECT role, state FROM project_members WHERE project_id = ? AND user_id = ?`)
    .get(projectId, uid) as { role: string; state: string } | undefined;
  if (!member || member.state !== 'active' || member.role === 'READ_ONLY') {
    throw ApiFailure.badRequest('That person cannot be given this task.', 'ASSIGNEE_NOT_IN_PROJECT');
  }
  return uid;
}

function checkSection(ctx: Ctx, projectId: string, sectionId: unknown): string | null {
  if (sectionId === null || sectionId === undefined || sectionId === '') return null;
  const section = ctx.db.prepare('SELECT project_id, is_deleted FROM sections WHERE id = ?').get(resolveId(ctx, sectionId)) as
    | { project_id: string; is_deleted: number } | undefined;
  if (!section || section.is_deleted || section.project_id !== projectId) {
    throw ApiFailure.badRequest('That section is not in this project.', 'SECTION_NOT_IN_PROJECT');
  }
  return resolveId(ctx, sectionId);
}

function checkParent(ctx: Ctx, projectId: string, parentId: unknown): string | null {
  if (parentId === null || parentId === undefined || parentId === '') return null;
  const parent = ctx.db.prepare('SELECT project_id, is_deleted FROM items WHERE id = ?').get(resolveId(ctx, parentId)) as
    | { project_id: string; is_deleted: number } | undefined;
  if (!parent || parent.is_deleted || parent.project_id !== projectId) {
    throw ApiFailure.badRequest('The parent task is not in this project.', 'PARENT_NOT_IN_PROJECT');
  }
  return resolveId(ctx, parentId);
}

/** Puts a new task at the end of its siblings, unless the app gave it a place. */
function placement(ctx: Ctx, args: Args, projectId: string, sectionId: string | null, parentId: string | null) {
  const where = 'project_id = ? AND is_deleted = 0 AND section_id IS ? AND parent_id IS ?';
  const params = [projectId, sectionId, parentId];
  const end = endOfList(ctx.db, 'items', where, params);
  const given = orderNumberArg(args, 'child_order');
  return {
    child_order: given ?? end.order,
    order_key: orderKeyArg(args.order_key) ?? end.key,
  };
}

export function addItem(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const parentArg = idArg(args, 'parent_id');
  let projectId = idArg(args, 'project_id') ?? viewer.inbox_project_id;
  let parent: string | null = null;
  let parentSection: string | null = null;
  if (parentArg) {
    // A parent the person cannot see answers like one that does not exist: nothing about it is revealed.
    const parentRow = loadItem(ctx, resolveId(ctx, parentArg));
    projectId = parentRow.project_id;
    parent = checkParent(ctx, projectId, parentArg);
    parentSection = parentRow.section_id;
  }
  projectId = resolveId(ctx, projectId);
  requireProject(db, projectId, viewer.id, 'write');
  const content = text(args, 'content', { required: true, max: MAX_CONTENT }) ?? '';
  const description = text(args, 'description', { max: MAX_DESCRIPTION }) ?? '';
  const priority = cleanPriority(args.priority) ?? 1;
  // A subtask is in its parent's section, as a moved one is; a section it names is not used.
  const section = parent ? parentSection : checkSection(ctx, projectId, args.section_id);
  const due = resolveDue(args.due as Parameters<typeof resolveDue>[0], ctx.today);
  const deadline = cleanDeadline(args.deadline);
  const duration = cleanDuration(args.duration);
  const labels = cleanLabels(args.labels);
  const responsible = assertAssignee(ctx, projectId, args.responsible_uid);
  const place = placement(ctx, args, projectId, section, parent);
  const itemId = newId();
  if (tempId) ctx.temps.set(tempId, itemId);
  const sequence = nextSeq(db);
  db.prepare(`INSERT INTO items (id, project_id, section_id, parent_id, content, description, priority,
      due_date, due_string, due_lang, due_timezone, due_recurring, deadline_date, deadline_lang,
      duration_amount, duration_unit, labels, child_order, order_key, day_order, collapsed, checked,
      added_by, added_at, updated_at, responsible_uid, seq)
    VALUES (@id, @project, @section, @parent, @content, @description, @priority,
      @due_date, @due_string, @due_lang, @due_timezone, @due_recurring, @deadline_date, @deadline_lang,
      @duration_amount, @duration_unit, @labels, @child_order, @order_key, -1, 0, 0,
      @added_by, @now, @now, @responsible, @seq)`).run({
    id: itemId,
    project: projectId,
    section,
    parent,
    content,
    description,
    priority,
    ...storedDue(due),
    deadline_date: deadline?.date ?? null,
    deadline_lang: deadline?.lang ?? null,
    duration_amount: duration?.amount ?? null,
    duration_unit: duration?.unit ?? null,
    labels: JSON.stringify(labels),
    child_order: place.child_order,
    order_key: place.order_key,
    added_by: viewer.id,
    now: ctx.now,
    responsible,
    seq: sequence,
  });
  // Subtasks in the same batch refer to this one through its temporary id; the mapping is set above.
}

export function updateItem(ctx: Ctx, args: Args): void {
  const { db } = ctx;
  const row = loadItem(ctx, resolveId(ctx, idArg(args, 'id', true)));
  requireProject(db, row.project_id, ctx.viewer.id, 'write');
  const set: Record<string, unknown> = {};
  if ('content' in args) set.content = text(args, 'content', { required: true, max: MAX_CONTENT });
  if ('description' in args) set.description = text(args, 'description', { max: MAX_DESCRIPTION }) ?? '';
  if ('priority' in args) set.priority = cleanPriority(args.priority) ?? 1;
  if ('due' in args) {
    const due = resolveDue(args.due as Parameters<typeof resolveDue>[0], ctx.today);
    Object.assign(set, storedDue(due));
  }
  if ('deadline' in args) {
    const deadline = cleanDeadline(args.deadline);
    set.deadline_date = deadline?.date ?? null;
    set.deadline_lang = deadline?.lang ?? null;
  }
  if ('duration' in args) {
    const duration = cleanDuration(args.duration);
    set.duration_amount = duration?.amount ?? null;
    set.duration_unit = duration?.unit ?? null;
  }
  if ('labels' in args) set.labels = JSON.stringify(cleanLabels(args.labels));
  if ('responsible_uid' in args) set.responsible_uid = assertAssignee(ctx, row.project_id, args.responsible_uid);
  if ('collapsed' in args || 'is_collapsed' in args) set.collapsed = truthy(args.collapsed ?? args.is_collapsed) ? 1 : 0;
  if ('day_order' in args) set.day_order = orderNumberArg(args, 'day_order') ?? -1;
  // A task dragged to a new place carries its new key. It is stored, so the place sticks.
  const orderKey = orderKeyArg(args.order_key);
  if (orderKey !== undefined) set.order_key = orderKey;
  const keys = Object.keys(set);
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE items SET ${assignments}, updated_at = @now, seq = @seq WHERE id = @id`)
    .run({ ...set, now: ctx.now, seq: nextSeq(db), id: row.id });
}

/** Ticks a task off and everything beneath it, which is what Todoist does for a parent. */
export function completeItem(ctx: Ctx, rootId: string): void {
  const { db } = ctx;
  const row = loadItem(ctx, rootId);
  requireProject(db, row.project_id, ctx.viewer.id, 'write');
  for (const id of subtreeIds(db, row.id)) {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow;
    if (item.is_deleted || item.checked) continue;
    markDone(ctx, item, false);
  }
}

function markDone(ctx: Ctx, item: ItemRow, recurring: boolean): void {
  const { db } = ctx;
  db.prepare('UPDATE items SET checked = 1, completed_at = ?, updated_at = ?, seq = ? WHERE id = ?')
    .run(ctx.now, ctx.now, nextSeq(db), item.id);
  recordCompletion(ctx, { ...item, checked: 1 }, recurring);
}

function recordCompletion(ctx: Ctx, item: ItemRow, recurring: boolean): void {
  ctx.db.prepare(`INSERT INTO completions (id, item_id, user_id, project_id, section_id, content, completed_at, recurring,
      labels, duration_amount, duration_unit, priority, responsible_uid, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId(), item.id, ctx.viewer.id, item.project_id, item.section_id, item.content, ctx.now, recurring ? 1 : 0,
    item.labels, item.duration_amount, item.duration_unit, item.priority, item.responsible_uid, item.parent_id,
  );
}

/**
 * Closes a task the way the app's "done" does. A repeating task moves to its
 * next occurrence and stays open, with the occurrence recorded in history;
 * anything else is ticked off.
 */
export function closeItem(ctx: Ctx, rootId: string): void {
  const { db } = ctx;
  const row = loadItem(ctx, rootId);
  requireProject(db, row.project_id, ctx.viewer.id, 'write');
  if (row.checked) return;
  if (row.due_recurring && row.due_date) {
    const next = advanceRecurring({
      date: row.due_date,
      string: row.due_string ?? '',
      lang: row.due_lang,
      timezone: row.due_timezone,
      recurring: true,
    }, ctx.today);
    recordCompletion(ctx, row, true);
    if (next) {
      db.prepare('UPDATE items SET due_date = ?, updated_at = ?, seq = ? WHERE id = ?')
        .run(next.date, ctx.now, nextSeq(db), row.id);
      return;
    }
    // The rule has run out: the task is finished for good.
    db.prepare('UPDATE items SET checked = 1, completed_at = ?, updated_at = ?, seq = ? WHERE id = ?')
      .run(ctx.now, ctx.now, nextSeq(db), row.id);
    return;
  }
  completeItem(ctx, row.id);
}

export function uncompleteItem(ctx: Ctx, itemId: string): void {
  const { db } = ctx;
  const row = loadItem(ctx, itemId);
  requireProject(db, row.project_id, ctx.viewer.id, 'write');
  if (!row.checked) return;
  db.prepare('UPDATE items SET checked = 0, completed_at = NULL, updated_at = ?, seq = ? WHERE id = ?')
    .run(ctx.now, nextSeq(db), row.id);
  // Only the latest ordinary completion is withdrawn; a repeating task's occurrences stay in the history.
  db.prepare(`DELETE FROM completions WHERE id = (
      SELECT id FROM completions WHERE item_id = ? AND recurring = 0 ORDER BY completed_at DESC LIMIT 1)`).run(row.id);
}

export function deleteItem(ctx: Ctx, itemId: string): void {
  const { db } = ctx;
  const row = loadItem(ctx, itemId);
  requireProject(db, row.project_id, ctx.viewer.id, 'write');
  for (const id of subtreeIds(db, row.id)) {
    db.prepare('UPDATE items SET is_deleted = 1, seq = ? WHERE id = ? AND is_deleted = 0').run(nextSeq(db), id);
    db.prepare('UPDATE notes SET is_deleted = 1, seq = ? WHERE item_id = ? AND is_deleted = 0').run(nextSeq(db), id);
    // Its reminders go with it, so a device that had them drops them.
    db.prepare('UPDATE reminders SET is_deleted = 1, seq = ? WHERE item_id = ? AND is_deleted = 0').run(nextSeq(db), id);
    db.prepare('UPDATE location_reminders SET is_deleted = 1, seq = ? WHERE item_id = ? AND is_deleted = 0').run(nextSeq(db), id);
  }
}

export function moveItem(ctx: Ctx, args: Args): void {
  const { db } = ctx;
  const row = loadItem(ctx, resolveId(ctx, idArg(args, 'id', true)));
  requireProject(db, row.project_id, ctx.viewer.id, 'write');
  const parentGiven = 'parent_id' in args;
  const parentId = parentGiven ? resolveId(ctx, args.parent_id) || null : null;
  const parent = parentId
    ? db.prepare(`SELECT * FROM items WHERE id = @id AND is_deleted = 0 AND ${visibleSql('project_id')}`).get({ id: parentId, viewer: ctx.viewer.id }) as ItemRow | undefined
    : undefined;
  if (parentId && !parent) throw ApiFailure.badRequest('The parent task does not exist.', 'PARENT_NOT_IN_PROJECT');
  if (parentId && subtreeIds(db, row.id).includes(parentId)) throw ApiFailure.badRequest('A task cannot be moved under itself.', 'CYCLE');

  // A section names its project, so a task sent to a section of another project needs no project as well.
  const sectionGiven = typeof args.section_id === 'string' && args.section_id ? resolveId(ctx, args.section_id) : null;
  const sectionProject = sectionGiven
    ? (db.prepare(`SELECT project_id FROM sections WHERE id = @id AND is_deleted = 0 AND ${visibleSql('project_id')}`)
      .get({ id: sectionGiven, viewer: ctx.viewer.id }) as { project_id: string } | undefined)?.project_id
    : undefined;
  const targetProject = resolveId(ctx, idArg(args, 'project_id') ?? sectionProject ?? parent?.project_id ?? row.project_id);
  requireProject(db, targetProject, ctx.viewer.id, 'write');
  const projectChanged = targetProject !== row.project_id;
  let section: string | null;
  if ('section_id' in args) section = checkSection(ctx, targetProject, args.section_id);
  else if (parent) section = parent.section_id;
  else section = projectChanged ? null : row.section_id;
  if (parent && 'section_id' in args && section !== parent.section_id) section = parent.section_id;
  if (parent && parent.project_id !== targetProject) throw ApiFailure.badRequest('The parent task is not in this project.', 'PARENT_NOT_IN_PROJECT');
  const finalParent = parentGiven ? parentId : parent ? parentId : null;

  const place = placement(ctx, { child_order: undefined }, targetProject, section, finalParent);
  const responsible = projectChanged && row.responsible_uid && !canBeAssigned(db, targetProject, row.responsible_uid)
    ? null
    : row.responsible_uid;
  db.prepare(`UPDATE items SET project_id = ?, section_id = ?, parent_id = ?, child_order = ?, order_key = ?,
      responsible_uid = ?, updated_at = ?, seq = ? WHERE id = ?`).run(
    targetProject, section, finalParent, place.child_order, place.order_key, responsible, ctx.now, nextSeq(db), row.id,
  );
  // Subtasks go with their parent into its project and section, whenever the parent moves to another section or project.
  for (const id of subtreeIds(db, row.id).filter((item) => item !== row.id)) {
    const sub = db.prepare('SELECT responsible_uid FROM items WHERE id = ?').get(id) as { responsible_uid: string | null };
    const keep = projectChanged && sub.responsible_uid && !canBeAssigned(db, targetProject, sub.responsible_uid) ? null : sub.responsible_uid;
    db.prepare('UPDATE items SET project_id = ?, section_id = ?, responsible_uid = ?, seq = ? WHERE id = ?')
      .run(targetProject, section, keep, nextSeq(db), id);
  }
  if (projectChanged) requireFullSyncFor(db, [row.project_id, targetProject]);
}

export function reorderItems(ctx: Ctx, args: Args): void {
  const { db } = ctx;
  const entries = Array.isArray(args.items) ? args.items as Array<{ id?: unknown; child_order?: unknown }> : [];
  if (entries.length === 0) return;
  const rows = entries.map((entry) => {
    if (!entry || typeof entry !== 'object') throw ApiFailure.badRequest('Each item order names a task.', 'INVALID_ARGUMENT');
    const row = loadItem(ctx, resolveId(ctx, entry.id));
    requireProject(db, row.project_id, ctx.viewer.id, 'write');
    const order = wholeNumber(entry.child_order);
    if (order === undefined) throw ApiFailure.badRequest('A child order is a whole number.', 'INVALID_ARGUMENT');
    return { row, order };
  });
  const group = rows[0].row;
  const siblings = db.prepare(`SELECT id, child_order, order_key FROM items
      WHERE project_id = ? AND is_deleted = 0 AND section_id IS ? AND parent_id IS ?`)
    .all(group.project_id, group.section_id, group.parent_id) as Array<{ id: string; child_order: number; order_key: string | null }>;
  const requested = new Map(rows.map(({ row, order }) => [row.id, order]));
  const sortKey = (row: { id: string; child_order: number }) => requested.get(row.id) ?? row.child_order;
  const ordered = [...siblings].sort((a, b) => sortKey(a) - sortKey(b) || a.child_order - b.child_order).map((row) => row.id);
  const sequence = () => nextSeq(db);
  renumber(db, 'items', siblings, ordered, sequence);
}

export function updateDayOrders(ctx: Ctx, args: Args): void {
  const { db } = ctx;
  const raw = args.ids_to_orders;
  const pairs: Array<[unknown, unknown]> = Array.isArray(raw)
    ? (raw as unknown[]).map((entry): [unknown, unknown] => {
      if (!entry || typeof entry !== 'object') throw ApiFailure.badRequest('Each order names an item and its day order.', 'INVALID_ARGUMENT');
      const { id, day_order } = entry as { id?: unknown; day_order?: unknown };
      return [id, day_order];
    })
    : Object.entries((raw ?? {}) as Record<string, unknown>);
  for (const [itemId, order] of pairs) {
    const dayOrder = wholeNumber(order);
    if (dayOrder === undefined) throw ApiFailure.badRequest('A day order is a whole number.', 'INVALID_ARGUMENT');
    const row = loadItem(ctx, resolveId(ctx, itemId));
    requireProject(db, row.project_id, ctx.viewer.id, 'write');
    db.prepare('UPDATE items SET day_order = ?, seq = ? WHERE id = ?').run(dayOrder, nextSeq(db), row.id);
  }
}

export const ITEM_COMMANDS = {
  item_add: (ctx: Ctx, args: Args, temp?: string) => addItem(ctx, args, temp),
  item_update: (ctx: Ctx, args: Args) => updateItem(ctx, args),
  item_update_day_orders: (ctx: Ctx, args: Args) => updateDayOrders(ctx, args),
  item_complete: (ctx: Ctx, args: Args) => completeItem(ctx, resolveId(ctx, idArg(args, 'id', true))),
  item_close: (ctx: Ctx, args: Args) => closeItem(ctx, resolveId(ctx, idArg(args, 'id', true))),
  item_uncomplete: (ctx: Ctx, args: Args) => uncompleteItem(ctx, resolveId(ctx, idArg(args, 'id', true))),
  item_delete: (ctx: Ctx, args: Args) => deleteItem(ctx, resolveId(ctx, idArg(args, 'id', true))),
  item_move: (ctx: Ctx, args: Args) => moveItem(ctx, args),
  item_reorder: (ctx: Ctx, args: Args) => reorderItems(ctx, args),
};

