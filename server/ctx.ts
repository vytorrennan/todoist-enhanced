import { keyBetween, keysInOrder } from '../src/domain/orderKey';
import { ApiFailure, type Db, newId, nextSeq, nowIso } from './db';
import type { UserRow } from './auth';
import { todayIn } from './dates';

export type Args = Record<string, unknown>;

/** What a command handler works with: the database, who is asking, and the temporary ids of this request. */
export interface Ctx {
  db: Db;
  viewer: UserRow;
  /** Temporary id (sent by the app) to the real id made for it in this request. */
  temps: Map<string, string>;
  now: string;
  today: string;
}

export function makeCtx(db: Db, viewer: UserRow, now = new Date()): Ctx {
  return {
    db, viewer, temps: new Map(), now: now.toISOString(), today: todayIn(viewer.timezone, now),
  };
}

/** The real id for an id the app may have made up while offline; the id itself otherwise. */
export function resolveId(ctx: Ctx, id: unknown): string {
  if (typeof id !== 'string') return '';
  return ctx.temps.get(id) ?? id;
}

export function seq(ctx: Ctx): number {
  return nextSeq(ctx.db);
}

/** A string argument. Missing or empty is an error when `required`. */
export function text(args: Args, key: string, options: { required?: boolean; max?: number } = {}): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (options.required) throw ApiFailure.badRequest(`“${key}” is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw ApiFailure.badRequest(`“${key}” must be text.`);
  const trimmed = key === 'content' || key === 'description' ? value : value.trim();
  if (options.required && !trimmed.trim()) throw ApiFailure.badRequest(`“${key}” cannot be empty.`);
  if (options.max && trimmed.length > options.max) throw ApiFailure.badRequest(`“${key}” is too long.`);
  return trimmed;
}

export function id(args: Args, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw ApiFailure.badRequest(`“${key}” is required.`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > 200) throw ApiFailure.badRequest(`“${key}” is not an id.`);
  return value;
}

export function integer(args: Args, key: string, options: { min?: number; max?: number } = {}): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw ApiFailure.badRequest(`“${key}” must be a whole number.`);
  if (options.min !== undefined && number < options.min) throw ApiFailure.badRequest(`“${key}” is too small.`);
  if (options.max !== undefined && number > options.max) throw ApiFailure.badRequest(`“${key}” is too large.`);
  return number;
}

export const truthy = (value: unknown): boolean => value === true || value === 1 || value === 'true';

/** Sibling ordering: a key that sorts after the last sibling, so a new row goes to the end. */
export function endOfList(db: Db, table: string, where: string, params: unknown[], keyColumn = 'order_key', orderColumn = 'child_order') {
  const last = db.prepare(`SELECT ${keyColumn} AS key, ${orderColumn} AS num FROM ${table} WHERE ${where}
      ORDER BY ${orderColumn} DESC, ${keyColumn} DESC LIMIT 1`).get(...params) as { key: string | null; num: number } | undefined;
  return {
    order: (last?.num ?? 0) + 1,
    key: keyBetween(last?.key ?? null, null),
  };
}

/**
 * Puts a set of siblings into one order: `ordered` first, in the order given,
 * then the rest by their current position. Every key is rewritten, so keys and
 * numbers always agree about the order.
 */
export function renumber(
  db: Db,
  table: 'items' | 'sections' | 'projects' | 'labels' | 'filters' | 'folders',
  rows: Array<{ id: string; child_order?: number; section_order?: number; item_order?: number; order_key: string | null }>,
  ordered: string[],
  nextSequence: () => number,
): void {
  const rank = new Map(ordered.map((value, index) => [value, index]));
  const sorted = [...rows].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
  const keys = keysInOrder(sorted.length);
  const numberColumn = table === 'sections' ? 'section_order' : table === 'labels' || table === 'filters' ? 'item_order' : 'child_order';
  const update = db.prepare(`UPDATE ${table} SET ${numberColumn} = ?, order_key = ?, seq = ? WHERE id = ?`);
  sorted.forEach((row, index) => {
    update.run(index + 1, keys[index], nextSequence(), row.id);
  });
}

export const stamp = nowIso;
export const makeId = newId;
