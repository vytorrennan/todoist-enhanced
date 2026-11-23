import { ApiFailure, type Db, newId, nextSeq } from './db';
import { type Args, type Ctx, endOfList, id as idArg, renumber, resolveId, text, truthy } from './ctx';
import { checkFilterQuery, runFilter } from './filterQuery';
import { parseLabels } from './serialize';

/** Labels (a person's own tags) and saved filters. */

export const MAX_NAME = 120;
const COLOR = /^[a-z_]{2,40}$/;

const cleanColor = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !COLOR.test(value)) throw ApiFailure.badRequest('That colour is not one the app knows.', 'INVALID_COLOR');
  return value;
};

interface LabelRow { id: string; user_id: string; name: string; color: string; item_order: number; order_key: string | null; is_favorite: number; is_deleted: number; seq: number }

/**
 * The active label with this name, in any case. SQLite folds only ASCII case, so the comparison is made here with the
 * same rule the app uses, and inside the same transaction as the write it guards.
 */
function activeLabelNamed(db: Db, userId: string, name: string, exceptId?: string): LabelRow | undefined {
  const wanted = name.toLowerCase();
  const rows = db.prepare('SELECT * FROM labels WHERE user_id = ? AND is_deleted = 0 AND id IS NOT ?')
    .all(userId, exceptId ?? null) as LabelRow[];
  return rows.find((row) => row.name.toLowerCase() === wanted);
}

/** Puts a new name on every task the person can see that carries the old one. */
export function renameOnItems(ctx: Ctx, from: string, to: string | null): void {
  const { db, viewer } = ctx;
  // Only tasks in projects this person may change: a read-only project keeps its labels whatever the owner of a tag renames.
  // Label names match without regard to case, as label names are unique without it. SQLite lowercases only ASCII, so the comparison is made here.
  const rows = db.prepare(`SELECT id, labels FROM items WHERE is_deleted = 0 AND labels != '[]'
      AND project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active' AND role != 'READ_ONLY')`)
    .all({ viewer: viewer.id }) as Array<{ id: string; labels: string }>;
  const wanted = from.toLowerCase();
  for (const row of rows) {
    const current = parseLabels(row.labels);
    if (!current.some((name) => name.toLowerCase() === wanted)) continue;
    const next: string[] = [];
    for (const name of current) {
      const value = name.toLowerCase() === wanted ? to : name;
      // Label names are unique whatever their case, so a rename never leaves two that match.
      if (value && !next.some((kept) => kept.toLowerCase() === value.toLowerCase())) next.push(value);
    }
    db.prepare('UPDATE items SET labels = ?, seq = ? WHERE id = ?').run(JSON.stringify(next), nextSeq(db), row.id);
  }
}

export function addLabel(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const name = text(args, 'name', { required: true, max: MAX_NAME }) ?? '';
  const existing = activeLabelNamed(db, viewer.id, name);
  if (existing) {
    // The same name twice is the same label: the temporary id is pointed at it.
    if (tempId) ctx.temps.set(tempId, existing.id);
    return;
  }
  const id = newId();
  if (tempId) ctx.temps.set(tempId, id);
  const end = endOfList(db, 'labels', 'user_id = ? AND is_deleted = 0', [viewer.id], 'order_key', 'item_order');
  db.prepare(`INSERT INTO labels (id, user_id, name, color, item_order, order_key, is_favorite, is_deleted, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    id, viewer.id, name, cleanColor(args.color) ?? 'charcoal', end.order, typeof args.order_key === 'string' ? args.order_key : end.key,
    truthy(args.is_favorite) ? 1 : 0, nextSeq(db),
  );
}

function ownLabel(ctx: Ctx, id: string): LabelRow {
  const row = ctx.db.prepare('SELECT * FROM labels WHERE id = ? AND user_id = ?').get(id, ctx.viewer.id) as LabelRow | undefined;
  if (!row || row.is_deleted) throw ApiFailure.notFound('That label does not exist.', 'LABEL_NOT_FOUND');
  return row;
}

export function updateLabel(ctx: Ctx, args: Args): void {
  const { db } = ctx;
  const label = ownLabel(ctx, resolveId(ctx, idArg(args, 'id', true)));
  const set: Record<string, unknown> = {};
  let rename: string | null = null;
  if ('name' in args) {
    const name = text(args, 'name', { required: true, max: MAX_NAME }) ?? '';
    if (name !== label.name) {
      if (activeLabelNamed(db, ctx.viewer.id, name, label.id)) throw ApiFailure.conflict('A label with that name already exists.', 'LABEL_EXISTS');
      set.name = name;
      rename = name;
    }
  }
  if ('color' in args) set.color = cleanColor(args.color) ?? label.color;
  if ('is_favorite' in args) set.is_favorite = truthy(args.is_favorite) ? 1 : 0;
  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE labels SET ${keys.map((key) => `${key} = @${key}`).join(', ')}, seq = @seq WHERE id = @id`)
      .run({ ...set, seq: nextSeq(db), id: label.id });
  }
  if (rename) renameOnItems(ctx, label.name, rename);
}

export function deleteLabel(ctx: Ctx, args: Args): void {
  const label = ownLabel(ctx, resolveId(ctx, idArg(args, 'id', true)));
  ctx.db.prepare('UPDATE labels SET is_deleted = 1, seq = ? WHERE id = ?').run(nextSeq(ctx.db), label.id);
  // Taking a label off the list takes it off every task too, as Todoist does.
  renameOnItems(ctx, label.name, null);
}

export function updateLabelOrders(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const mapping = (args.id_order_mapping ?? {}) as Record<string, unknown>;
  const rows = db.prepare('SELECT id, item_order, order_key FROM labels WHERE user_id = ? AND is_deleted = 0')
    .all(viewer.id) as Array<{ id: string; item_order: number; order_key: string | null }>;
  const ordered = Object.entries(mapping)
    .filter(([id]) => rows.some((row) => row.id === id))
    .sort(([, a], [, b]) => Number(a) - Number(b))
    .map(([id]) => id);
  renumber(db, 'labels', rows, ordered, () => nextSeq(db));
}

/** Filters ------------------------------------------------------------------ */

interface FilterRow { id: string; user_id: string; name: string; query: string; description: string; color: string; item_order: number; order_key: string | null; is_favorite: number; is_deleted: number; seq: number }

function ownFilter(ctx: Ctx, id: string): FilterRow {
  const row = ctx.db.prepare('SELECT * FROM filters WHERE id = ? AND user_id = ?').get(id, ctx.viewer.id) as FilterRow | undefined;
  if (!row || row.is_deleted) throw ApiFailure.notFound('That filter does not exist.', 'FILTER_NOT_FOUND');
  return row;
}

export function addFilter(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const name = text(args, 'name', { required: true, max: MAX_NAME }) ?? '';
  const query = text(args, 'query', { required: true, max: 500 }) ?? '';
  checkFilterQuery(query);
  const id = newId();
  if (tempId) ctx.temps.set(tempId, id);
  const end = endOfList(db, 'filters', 'user_id = ? AND is_deleted = 0', [viewer.id], 'order_key', 'item_order');
  db.prepare(`INSERT INTO filters (id, user_id, name, query, description, color, item_order, order_key, is_favorite, is_deleted, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    id, viewer.id, name, query, text(args, 'description', { max: 2000 }) ?? '', cleanColor(args.color) ?? 'charcoal',
    typeof args.item_order === 'number' ? args.item_order : end.order, typeof args.order_key === 'string' ? args.order_key : end.key,
    truthy(args.is_favorite) ? 1 : 0, nextSeq(db),
  );
}

export function updateFilter(ctx: Ctx, args: Args): void {
  const filter = ownFilter(ctx, resolveId(ctx, idArg(args, 'id', true)));
  const set: Record<string, unknown> = {};
  if ('name' in args) set.name = text(args, 'name', { required: true, max: MAX_NAME });
  if ('query' in args) {
    const query = text(args, 'query', { required: true, max: 500 }) ?? '';
    checkFilterQuery(query);
    set.query = query;
  }
  if ('description' in args) set.description = text(args, 'description', { max: 2000 }) ?? '';
  if ('color' in args) set.color = cleanColor(args.color) ?? filter.color;
  if ('is_favorite' in args) set.is_favorite = truthy(args.is_favorite) ? 1 : 0;
  if ('item_order' in args && typeof args.item_order === 'number') set.item_order = args.item_order;
  // A filter moved in the list gets a new key between its neighbours; the key is kept, not ignored.
  if ('order_key' in args && typeof args.order_key === 'string' && args.order_key.length > 0 && args.order_key.length <= 64) {
    set.order_key = args.order_key;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    ctx.db.prepare(`UPDATE filters SET ${keys.map((key) => `${key} = @${key}`).join(', ')}, seq = @seq WHERE id = @id`)
      .run({ ...set, seq: nextSeq(ctx.db), id: filter.id });
  }
}

export function deleteFilter(ctx: Ctx, args: Args): void {
  const filter = ownFilter(ctx, resolveId(ctx, idArg(args, 'id', true)));
  ctx.db.prepare('UPDATE filters SET is_deleted = 1, seq = ? WHERE id = ?').run(nextSeq(ctx.db), filter.id);
}

export function updateFilterOrders(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const mapping = (args.id_order_mapping ?? {}) as Record<string, unknown>;
  const rows = db.prepare('SELECT id, item_order, order_key FROM filters WHERE user_id = ? AND is_deleted = 0')
    .all(viewer.id) as Array<{ id: string; item_order: number; order_key: string | null }>;
  const ordered = Object.entries(mapping)
    .filter(([id]) => rows.some((row) => row.id === id))
    .sort(([, a], [, b]) => Number(a) - Number(b))
    .map(([id]) => id);
  renumber(db, 'filters', rows, ordered, () => nextSeq(db));
}

/** The tasks a saved filter shows for this person, one page at a time. */
export function filterPage(db: Db, viewerId: string, query: string, today: string, cursor: number, limit: number) {
  const ids = runFilter(db, viewerId, query, today);
  const slice = ids.slice(cursor, cursor + limit);
  return { results: slice.map((id) => ({ id })), next_cursor: cursor + limit < ids.length ? String(cursor + limit) : null };
}

export const LABEL_COMMANDS = {
  label_add: (ctx: Ctx, args: Args, temp?: string) => addLabel(ctx, args, temp),
  label_update: (ctx: Ctx, args: Args) => updateLabel(ctx, args),
  label_delete: (ctx: Ctx, args: Args) => deleteLabel(ctx, args),
  label_update_orders: (ctx: Ctx, args: Args) => updateLabelOrders(ctx, args),
  filter_add: (ctx: Ctx, args: Args, temp?: string) => addFilter(ctx, args, temp),
  filter_update: (ctx: Ctx, args: Args) => updateFilter(ctx, args),
  filter_delete: (ctx: Ctx, args: Args) => deleteFilter(ctx, args),
  filter_update_orders: (ctx: Ctx, args: Args) => updateFilterOrders(ctx, args),
};

