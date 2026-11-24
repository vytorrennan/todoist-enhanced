import { ApiFailure, type Db } from './db';
import { addDays, dayPart, isDay } from './dates';
import type { ItemRow } from './serialize';
import { parseLabels } from './serialize';
import { VISIBLE_PROJECT_SQL, visibleSql } from './access';

/**
 * Saved filters: a query such as `today & p1` or `#Work | @waiting`.
 *
 * The operators are Todoist's: `&` and, `|` or, `!` not, and parentheses.
 * The terms are the ones the app's filters use: dates (`today`, `tomorrow`,
 * `overdue`, `no date`, `next 7 days`, a day as `2026-12-01` or `due: 2026-12-01`, `due before:`,
 * `due after:`), priorities (`p1` to `p4`), projects (`#Name`, and
 * `##Name` for a project and everything under it), labels (`@name`), sections
 * (`/name`), people (`assigned to: me`, `assigned to: none`, `assigned by:
 * me`), words (`search: text`), `recurring`, `no labels`, `view all`.
 *
 * A term it does not know is an error, never a silent match-nothing: a filter
 * that quietly shows the wrong tasks is worse than one that says why it cannot.
 */

type Token = { kind: 'term'; text: string } | { kind: 'op'; op: '&' | '|' | '!' | '(' | ')' };
type Node =
  | { kind: 'and' | 'or'; left: Node; right: Node }
  | { kind: 'not'; child: Node }
  | { kind: 'term'; text: string };

export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let buffer = '';
  let quoted = false;
  const flush = () => {
    const text = buffer.trim();
    if (text) tokens.push({ kind: 'term', text });
    buffer = '';
  };
  for (const char of query) {
    if (char === '"') { quoted = !quoted; buffer += char; continue; }
    if (!quoted && (char === '&' || char === '|' || char === '!' || char === '(' || char === ')')) {
      flush();
      tokens.push({ kind: 'op', op: char });
      continue;
    }
    buffer += char;
  }
  if (quoted) throw ApiFailure.badRequest('A quotation mark is not closed in this filter.', 'INVALID_FILTER');
  flush();
  return tokens;
}

/**
 * A saved filter may hold several lists, split by commas outside brackets and
 * quotes. Each list is checked as a query of its own, so a broken one is
 * refused when the filter is saved.
 */
export function checkFilterQuery(query: string): void {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let part = '';
  for (const char of query) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')') depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && char === ',') {
      parts.push(part);
      part = '';
      continue;
    }
    part += char;
  }
  parts.push(part);
  const lists = parts.map((value) => value.trim()).filter(Boolean);
  if (lists.length === 0) throw ApiFailure.badRequest('A filter needs a query.', 'INVALID_FILTER');
  for (const list of lists) parseQuery(list);
}

/** Parses a query, so a broken one is refused before it is saved or run. */
export function parseQuery(query: string): Node {
  const tokens = tokenize(query);
  if (tokens.length === 0) throw ApiFailure.badRequest('A filter needs a query.', 'INVALID_FILTER');
  let at = 0;
  const peek = () => tokens[at];
  const fail = (message: string): never => {
    throw ApiFailure.badRequest(message, 'INVALID_FILTER');
  };
  function or(): Node {
    let left = and();
    while (peek()?.kind === 'op' && (peek() as { op: string }).op === '|') {
      at += 1;
      left = { kind: 'or', left, right: and() };
    }
    return left;
  }
  function and(): Node {
    let left = unary();
    while (peek()?.kind === 'op' && (peek() as { op: string }).op === '&') {
      at += 1;
      left = { kind: 'and', left, right: unary() };
    }
    return left;
  }
  function unary(): Node {
    const token = peek();
    if (token?.kind === 'op' && token.op === '!') {
      at += 1;
      return { kind: 'not', child: unary() };
    }
    return primary();
  }
  function primary(): Node {
    const token = peek();
    if (!token) return fail('The filter ends before it is finished.');
    if (token.kind === 'op' && token.op === '(') {
      at += 1;
      const inner = or();
      if (peek()?.kind !== 'op' || (peek() as { op: string }).op !== ')') fail('A bracket in this filter is not closed.');
      at += 1;
      return inner;
    }
    if (token.kind === 'term') {
      at += 1;
      return { kind: 'term', text: token.text };
    }
    return fail('An operator in this filter has nothing to join.');
  }
  const tree = or();
  if (at < tokens.length) throw ApiFailure.badRequest('This filter has something after it that does not fit.', 'INVALID_FILTER');
  // Every term is checked now, so an unknown one fails when the filter is saved.
  walk(tree, (text) => { checkTerm(text); });
  return tree;
}

function walk(node: Node, visit: (text: string) => void): void {
  if (node.kind === 'term') visit(node.text);
  else if (node.kind === 'not') walk(node.child, visit);
  else { walk(node.left, visit); walk(node.right, visit); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What a term means, or null if it is not one of the supported forms. */
type TermTest = (ctx: EvalContext, item: ItemRow) => boolean;

function compileTerm(raw: string): TermTest | null {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (lower === 'view all' || lower === 'all') return () => true;
  if (lower === 'today') return (ctx, item) => dueDay(item) === ctx.today;
  if (lower === 'tomorrow') return (ctx, item) => dueDay(item) === addDays(ctx.today, 1);
  if (lower === 'overdue') return (ctx, item) => { const day = dueDay(item); return day !== null && day < ctx.today; };
  if (lower === 'no date' || lower === 'no due date') return (_ctx, item) => dueDay(item) === null;
  if (lower === 'recurring') return (_ctx, item) => item.due_recurring === 1;
  if (lower === 'no labels') return (_ctx, item) => parseLabels(item.labels).length === 0;
  const next = /^next (\d{1,3}) days?$/.exec(lower);
  if (next) {
    const span = Number(next[1]);
    return (ctx, item) => { const day = dueDay(item); return day !== null && day >= ctx.today && day < addDays(ctx.today, span); };
  }
  if (DATE_RE.test(lower)) return (_ctx, item) => dueDay(item) === lower;
  const priority = /^p([1-4])$/.exec(lower);
  if (priority) {
    const wanted = 5 - Number(priority[1]);
    return (_ctx, item) => item.priority === wanted;
  }
  // `due: 2030-01-15` is the tasks due that day, and `date: 2030-01-15` those scheduled for it.
  const dueOn = /^(due|date): ?(\d{4}-\d{2}-\d{2})$/.exec(lower);
  if (dueOn && isDay(dueOn[2])) {
    const [, field, date] = dueOn;
    return (_ctx, item) => (field === 'due' ? dueDay(item) ?? deadlineDay(item) : dueDay(item)) === date;
  }
  // `due` is the scheduled day, or the deadline when a task has no scheduled day; `date` is the scheduled day only.
  const dueBound = /^(due|date) (before|after): ?(\d{4}-\d{2}-\d{2})$/.exec(lower);
  if (dueBound) {
    const [, field, which, date] = dueBound;
    return (_ctx, item) => {
      const day = field === 'due' ? dueDay(item) ?? deadlineDay(item) : dueDay(item);
      if (day === null) return false;
      return which === 'before' ? day < date : day > date;
    };
  }
  const deadlineBound = /^deadline (before|after): ?(\d{4}-\d{2}-\d{2})$/.exec(lower);
  if (deadlineBound) {
    const [, which, date] = deadlineBound;
    return (_ctx, item) => {
      const day = deadlineDay(item);
      if (day === null) return false;
      return which === 'before' ? day < date : day > date;
    };
  }
  const search = /^search: ?(.+)$/i.exec(text);
  if (search) {
    const needle = unquote(search[1]).toLowerCase();
    return (_ctx, item) => `${item.content}\n${item.description}`.toLowerCase().includes(needle);
  }
  const assigned = /^assigned to: ?(.+)$/i.exec(text);
  if (assigned) {
    const who = unquote(assigned[1]).toLowerCase();
    if (who === 'none' || who === 'unassigned') return (_ctx, item) => item.responsible_uid === null;
    return (ctx, item) => {
      if (who === 'me') return item.responsible_uid === ctx.viewerId;
      const person = ctx.people.get(who);
      return person !== undefined && item.responsible_uid === person;
    };
  }
  if (/^assigned by: ?me$/i.test(text)) return (ctx, item) => item.added_by === ctx.viewerId && item.responsible_uid !== null && item.responsible_uid !== ctx.viewerId;
  const projectDeep = /^##(.+)$/.exec(text);
  if (projectDeep) {
    const name = unquote(projectDeep[1]).toLowerCase();
    return (ctx, item) => ctx.projectsNamed(name, true).has(item.project_id);
  }
  const project = /^#(.+)$/.exec(text);
  if (project) {
    const name = unquote(project[1]).toLowerCase();
    return (ctx, item) => ctx.projectsNamed(name, false).has(item.project_id);
  }
  const label = /^@(.+)$/.exec(text);
  if (label) {
    const name = unquote(label[1]).toLowerCase();
    return (_ctx, item) => parseLabels(item.labels).some((value) => value.toLowerCase() === name);
  }
  const section = /^\/(.+)$/.exec(text);
  if (section) {
    const name = unquote(section[1]).toLowerCase();
    return (ctx, item) => item.section_id !== null && (ctx.sectionNames.get(item.section_id) ?? '').toLowerCase() === name;
  }
  return null;
}

function checkTerm(text: string): void {
  if (compileTerm(text) === null) {
    throw ApiFailure.badRequest(`The filter “${text}” is not one the app can read yet.`, 'INVALID_FILTER');
  }
}

const unquote = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
};

const dueDay = (item: ItemRow): string | null => (item.due_date ? dayPart(item.due_date) : null);
const deadlineDay = (item: ItemRow): string | null => (item.deadline_date ? item.deadline_date.slice(0, 10) : null);

interface EvalContext {
  viewerId: string;
  today: string;
  people: Map<string, string>;
  sectionNames: Map<string, string>;
  projectsNamed: (name: string, deep: boolean) => Set<string>;
}

/** The ids of the open tasks a filter matches, in the order they should be shown. */
export function runFilter(db: Db, viewerId: string, query: string, today: string): string[] {
  const tree = parseQuery(query);
  const projects = db.prepare(`SELECT id, name, parent_id FROM projects WHERE is_deleted = 0 AND ${visibleSql('id')}`)
    .all({ viewer: viewerId }) as Array<{ id: string; name: string; parent_id: string | null }>;
  const byName = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const project of projects) {
    const key = project.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), project.id]);
    if (project.parent_id) children.set(project.parent_id, [...(children.get(project.parent_id) ?? []), project.id]);
  }
  const under = (rootIds: string[]): Set<string> => {
    const out = new Set<string>();
    const stack = [...rootIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    return out;
  };
  const people = new Map<string, string>();
  for (const row of db.prepare(`SELECT id, email, full_name FROM users WHERE id IN (
      SELECT user_id FROM project_members WHERE state = 'active' AND ${VISIBLE_PROJECT_SQL}
    )`).all({ viewer: viewerId }) as Array<{ id: string; email: string; full_name: string }>) {
    people.set(row.email.toLowerCase(), row.id);
    if (row.full_name) people.set(row.full_name.toLowerCase(), row.id);
  }
  const sectionNames = new Map<string, string>();
  for (const row of db.prepare(`SELECT id, name FROM sections WHERE is_deleted = 0 AND ${VISIBLE_PROJECT_SQL}`).all({ viewer: viewerId }) as Array<{ id: string; name: string }>) {
    sectionNames.set(row.id, row.name);
  }
  const ctx: EvalContext = {
    viewerId,
    today,
    people,
    sectionNames,
    projectsNamed: (name, deep) => {
      const direct = byName.get(name) ?? [];
      return new Set(deep ? under(direct) : direct);
    },
  };
  const items = db.prepare(`SELECT * FROM items WHERE is_deleted = 0 AND checked = 0 AND ${VISIBLE_PROJECT_SQL}`)
    .all({ viewer: viewerId }) as ItemRow[];

  const evaluate = (node: Node, item: ItemRow): boolean => {
    switch (node.kind) {
      case 'and': return evaluate(node.left, item) && evaluate(node.right, item);
      case 'or': return evaluate(node.left, item) || evaluate(node.right, item);
      case 'not': return !evaluate(node.child, item);
      case 'term': return (compileTerm(node.text) as TermTest)(ctx, item);
    }
  };
  const matches = items.filter((item) => evaluate(tree, item));
  matches.sort((a, b) => {
    const dayA = dueDay(a);
    const dayB = dueDay(b);
    if (dayA !== dayB) {
      if (dayA === null) return 1;
      if (dayB === null) return -1;
      if (dayA !== dayB) return dayA < dayB ? -1 : 1;
    }
    return b.priority - a.priority || a.child_order - b.child_order;
  });
  return matches.map((item) => item.id);
}
