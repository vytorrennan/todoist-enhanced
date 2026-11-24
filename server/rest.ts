import type { Db } from './db';
import { ApiFailure } from './db';
import type { UserRow } from './auth';
import type { Request, Response, Router } from './http';
import { applyDirect } from './commands';
import { requireWorkspace, visibleSql } from './access';
import { type Args, makeCtx } from './ctx';
import { filterPage, labelKey, MAX_NAME, renameOnItems, sharedLabelNames } from './labels';
import { loadNote } from './notes';
import { todayIn } from './dates';
import { dueFromWords } from './due';
import { collaboratorShape, commentShape, folderShape, labelShape, locationReminderApiShape, projectShape, reminderApiShape, sectionShape, taskShape, userApiShape, workspaceApiShape } from './rest-shapes';
import { locationReminderList, reminderList, visibleLocationReminder, visibleReminder } from './reminders';
import { listActivity } from './activity';
import { importCsv, projectCsv } from './templates';
import { filterOut } from './serialize';
import { activityStatsOf, healthOf, productivityOf, progressOf, workspaceInsightsOf } from './insights';
import { updateUser } from './account';
import type { ItemRow, NoteRow, ProjectRow } from './serialize';

/**
 * The REST API v1: the routes the official SDK calls, with the objects the
 * API returns. Each write runs the same handler a sync command runs, so the
 * two surfaces cannot disagree about what a change does.
 */

const PROJECT_SELECT = `SELECT p.id, p.name, p.description, p.color, p.parent_id, p.workspace_id, p.folder_id, p.view_style,
    p.is_inbox, p.is_archived, p.archived_at, p.is_deleted, p.access_visibility, p.created_at, p.seq,
    m.role, m.is_favorite, m.collapsed, m.child_order, m.order_key,
    (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id AND x.state = 'active') AS shared_count
  FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = @viewer AND m.state = 'active'`;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function listOf(value: string | null): unknown[] | undefined {
  if (value === null || value === '') return undefined;
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      throw ApiFailure.badRequest('That list is not valid.', 'INVALID_ARGUMENT');
    }
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Whether a name matches a search the way the official clients send it. Text anywhere in the name matches. Once the
 * search has a `*`, the whole name must fit it, each `*` standing for any run of characters. Case does not matter, and
 * `\*` is a literal star. The matching is a single pass over the name for each part of the search, so no search can
 * make the server slow.
 */
/**
 * Case folding for name matches: lower case, and the two letters that lower case alone does not fold to their match. The
 * Greek final sigma becomes sigma, and the German sharp s becomes ss, as Unicode case folding has them.
 */
const foldCase = (text: string): string => text.toLowerCase().replaceAll('ς', 'σ').replaceAll('ß', 'ss');

export function nameMatches(name: string, query: string): boolean {
  const parts: string[] = [];
  const chars = [...foldCase(query)];
  let literal = '';
  let starred = false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === '\\' && (chars[i + 1] === '\\' || chars[i + 1] === '*')) {
      literal += chars[i + 1];
      i += 1;
    } else if (char === '*') {
      starred = true;
      parts.push(literal);
      literal = '';
    } else {
      literal += char;
    }
  }
  parts.push(literal);

  const text = foldCase(name);
  if (!starred) return text.includes(literal);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  // The parts between the stars come in order, in the part of the name that the first and last parts leave.
  const end = text.length - last.length;
  let position = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, position);
    if (found === -1 || found + part.length > end) return false;
    position = found + part.length;
  }
  return true;
}

function pageOf(req: Request): { cursor: number; limit: number } {
  const cursor = Number(req.query.get('cursor') ?? 0);
  const limit = Number(req.query.get('limit') ?? DEFAULT_LIMIT);
  // A safe integer only: SQLite refuses a larger number bound as an OFFSET or LIMIT, and a refused page is a server error.
  return {
    cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
    limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

/** One page of a list the server holds in full, and where the next page starts. */
function pageOfList<T, U>(items: T[], page: { cursor: number; limit: number }, shape: (item: T) => U): { results: U[]; next_cursor: string | null } {
  return {
    results: items.slice(page.cursor, page.cursor + page.limit).map((item) => shape(item)),
    next_cursor: items.length > page.cursor + page.limit ? String(page.cursor + page.limit) : null,
  };
}

/** The text a search is for. A search that names no text is refused, rather than read as a search for everything. */
function searchQueryOf(req: Request): string {
  const query = req.query.get('query');
  if (query === null) throw ApiFailure.badRequest('Say what to search for.', 'INVALID_ARGUMENT');
  return query;
}

/**
 * The sections of the projects this person can see: all of them, or those of one project. With a search, only the active
 * sections whose names match, and only one page of them (plus one more, to tell whether a next page exists): the
 * database stops at the end of the page rather than listing every match.
 */
function visibleSections(db: Db, viewer: UserRow, project: string | null, search?: { query: string; page: { cursor: number; limit: number } }): SectionWithProject[] {
  const where = [`s.is_deleted = 0`, visibleSql('s.project_id')];
  const params: Record<string, unknown> = { viewer: viewer.id };
  if (project) { where.push('s.project_id = @project'); params.project = project; }
  let tail = 'ORDER BY s.project_id, s.section_order';
  if (search) {
    where.push('s.is_archived = 0', 'name_matches(s.name, @query)');
    Object.assign(params, { query: search.query, limit: search.page.limit + 1, offset: search.page.cursor });
    tail += ' LIMIT @limit OFFSET @offset';
  }
  return db.prepare(`SELECT s.*, p.created_at AS project_created, p.created_by AS owner FROM sections s JOIN projects p ON p.id = s.project_id
    WHERE ${where.join(' AND ')} ${tail}`).all(params) as SectionWithProject[];
}

/** The rows of one page, cut by the database to the page plus one, and where the next page starts. */
function pageFromRows<T, U>(rows: T[], page: { cursor: number; limit: number }, shape: (row: T) => U): { results: U[]; next_cursor: string | null } {
  return {
    results: rows.slice(0, page.limit).map((row) => shape(row)),
    next_cursor: rows.length > page.limit ? String(page.cursor + page.limit) : null,
  };
}

/** A page of the personal labels of a person, in the order they keep them, with the name matched in the database when asked. */
function labelPage(db: Db, userId: string, page: { cursor: number; limit: number }, query?: string): Array<Parameters<typeof labelShape>[0]> {
  const where = ['user_id = @user', 'is_deleted = 0'];
  const params: Record<string, unknown> = { user: userId, limit: page.limit + 1, offset: page.cursor };
  if (query !== undefined) { where.push('name_matches(name, @query)'); params.query = query; }
  return db.prepare(`SELECT * FROM labels WHERE ${where.join(' AND ')} ORDER BY item_order LIMIT @limit OFFSET @offset`)
    .all(params) as Array<Parameters<typeof labelShape>[0]>;
}

function bodyOf(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/**
 * The task fields a REST body names, in the command's own argument names. A
 * due string is read as the API reads it: a repeat rule when it is one, else
 * a day or a day and time, counted from the viewer's today.
 */
export function taskArgs(body: Record<string, unknown>, viewer: UserRow): Args {
  const args: Args = {};
  for (const key of ['content', 'description', 'project_id', 'section_id', 'parent_id', 'priority']) {
    if (key in body) args[key] = body[key];
  }
  if ('labels' in body) args.labels = body.labels;
  if ('assignee_id' in body) args.responsible_uid = body.assignee_id;
  const due = dueArg(body, viewer);
  if (due) args.due = due;
  if ('deadline_date' in body) args.deadline = body.deadline_date ? { date: body.deadline_date, lang: 'en' } : null;
  if ('duration' in body) {
    args.duration = body.duration ? { amount: body.duration, unit: body.duration_unit ?? 'minute' } : null;
  }
  return args;
}

function dueArg(body: Record<string, unknown>, viewer: UserRow): Record<string, unknown> | undefined {
  if (!('due_string' in body) && !('due_date' in body) && !('due_datetime' in body)) return undefined;
  const explicit = typeof body.due_datetime === 'string' ? body.due_datetime : typeof body.due_date === 'string' ? body.due_date : undefined;
  const due: Record<string, unknown> = {};
  if (typeof body.due_lang === 'string') due.lang = body.due_lang;
  if (typeof body.timezone === 'string') due.timezone = body.timezone;
  if (explicit) {
    due.date = explicit;
    if (typeof body.due_string === 'string') due.string = body.due_string;
    return due;
  }
  const words = typeof body.due_string === 'string' ? body.due_string.trim() : '';
  if (!words) return due;
  return { ...due, ...dueFromWords(words, viewer) };
}

function noteCounts(db: Db, ids: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const rows = db.prepare(`SELECT item_id, COUNT(*) AS n FROM notes WHERE is_deleted = 0 AND item_id IN (SELECT value FROM json_each(?)) GROUP BY item_id`)
    .all(JSON.stringify(ids)) as Array<{ item_id: string; n: number }>;
  for (const row of rows) counts.set(row.item_id, row.n);
  return counts;
}

function itemRow(db: Db, viewerId: string, id: string): ItemRow {
  const row = db.prepare(`SELECT * FROM items WHERE id = @id AND is_deleted = 0 AND ${visibleSql('project_id')}`)
    .get({ id, viewer: viewerId }) as ItemRow | undefined;
  if (!row) throw ApiFailure.notFound('That task does not exist.', 'ITEM_NOT_FOUND');
  return row;
}

function projectRow(db: Db, viewerId: string, id: string): ProjectRow {
  const row = db.prepare(`${PROJECT_SELECT} WHERE p.id = @id AND p.is_deleted = 0`).get({ viewer: viewerId, id }) as ProjectRow | undefined;
  if (!row) throw ApiFailure.notFound('That project does not exist.', 'PROJECT_NOT_FOUND');
  return row;
}

export function registerRest(router: Router, db: Db): void {
  // The task filter compares label names by labelKey, so a label matches whichever case or accents its task spells it with.
  db.function('label_key', { deterministic: true }, (value: unknown) => (typeof value === 'string' ? labelKey(value) : null));
  // The name search matches in the database, so a page of a search stops there (see labelPage and visibleSections).
  db.function('name_matches', { deterministic: true }, (name: unknown, query: unknown) => (typeof name === 'string' && typeof query === 'string' && nameMatches(name, query) ? 1 : 0));
  const viewerOf = (req: Request): UserRow => req.user as UserRow;
  const taskOut = (db: Db, viewer: UserRow, id: string) => {
    const row = itemRow(db, viewer.id, id);
    return taskShape(row, noteCounts(db, [row.id]).get(row.id) ?? 0);
  };
  const projectOutFor = (db: Db, viewer: UserRow, id: string) => projectShape(projectRow(db, viewer.id, id));

  /* User -------------------------------------------------------------- */

  router.add('GET', '/api/v1/user', 'bearer', (req, res) => {
    res.json(userApiShape(viewerOf(req)));
  });

  router.add('POST', '/api/v1/user', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    updateUser(makeCtx(db, viewer), bodyOf(req));
    res.json(userApiShape(db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id) as UserRow));
  });

  /* Tasks ------------------------------------------------------------- */

  router.add('GET', '/api/v1/tasks', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const where = ['i.is_deleted = 0', 'i.checked = 0', visibleSql('i.project_id')];
    const params: Record<string, unknown> = { viewer: viewer.id };
    const scalar: Array<[string, string]> = [['project_id', 'i.project_id'], ['section_id', 'i.section_id'], ['parent_id', 'i.parent_id']];
    for (const [param, column] of scalar) {
      const value = req.query.get(param);
      if (value) { where.push(`${column} = @${param}`); params[param] = value; }
    }
    const label = req.query.get('label');
    if (label) {
      where.push('EXISTS (SELECT 1 FROM json_each(i.labels) WHERE label_key(value) = @label)');
      params.label = labelKey(label);
    }
    const ids = listOf(req.query.get('ids'));
    if (ids) {
      where.push('i.id IN (SELECT value FROM json_each(@ids))');
      params.ids = JSON.stringify(ids);
    }
    const { cursor, limit } = pageOf(req);
    const rows = db.prepare(`SELECT i.* FROM items i WHERE ${where.join(' AND ')} ORDER BY i.project_id, i.child_order LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: limit + 1, offset: cursor }) as ItemRow[];
    const page = rows.slice(0, limit);
    const counts = noteCounts(db, page.map((row) => row.id));
    res.json({
      results: page.map((row) => taskShape(row, counts.get(row.id) ?? 0)),
      next_cursor: rows.length > limit ? String(cursor + limit) : null,
    });
  });

  router.add('POST', '/api/v1/tasks', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'item_add', taskArgs(bodyOf(req), viewer), temp);
    res.json(taskOut(db, viewer, temps.get(temp) ?? ''));
  });

  router.add('GET', '/api/v1/tasks/filter', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const { cursor, limit } = pageOf(req);
    const page = filterPage(db, viewer.id, req.query.get('query') ?? '', todayIn(viewer.timezone), cursor, Math.min(limit, 500));
    const counts = noteCounts(db, page.results.map((hit) => hit.id));
    res.json({
      results: page.results.map((hit) => {
        const row = db.prepare('SELECT * FROM items WHERE id = ?').get(hit.id) as ItemRow;
        return taskShape(row, counts.get(row.id) ?? 0);
      }),
      next_cursor: page.next_cursor,
    });
  });

  router.add('GET', '/api/v1/tasks/completed/by_completion_date', 'bearer', (req, res) => {
    res.json(completedPage(db, viewerOf(req), req, 'completed_at'));
  });

  router.add('GET', '/api/v1/tasks/completed/by_due_date', 'bearer', (req, res) => {
    res.json(completedPage(db, viewerOf(req), req, 'due_date'));
  });

  router.add('GET', '/api/v1/tasks/:id', 'bearer', (req, res) => {
    res.json(taskOut(db, viewerOf(req), req.params.id));
  });

  router.add('POST', '/api/v1/tasks/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'item_update', { ...taskArgs(bodyOf(req), viewer), id: req.params.id });
    res.json(taskOut(db, viewer, req.params.id));
  });

  router.add('DELETE', '/api/v1/tasks/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'item_delete', { id: req.params.id });
    res.empty();
  });

  router.add('POST', '/api/v1/tasks/:id/close', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'item_close', { id: req.params.id });
    res.empty();
  });

  router.add('POST', '/api/v1/tasks/:id/reopen', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'item_uncomplete', { id: req.params.id });
    res.empty();
  });

  router.add('POST', '/api/v1/tasks/:id/move', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const body = bodyOf(req);
    const args: Args = { id: req.params.id };
    for (const key of ['project_id', 'section_id', 'parent_id']) if (key in body) args[key] = body[key];
    applyDirect(db, viewer, 'item_move', args);
    res.json(taskOut(db, viewer, req.params.id));
  });

  /* Projects ---------------------------------------------------------- */

  router.add('GET', '/api/v1/projects', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const rows = db.prepare(`${PROJECT_SELECT} WHERE p.is_deleted = 0 AND p.is_archived = 0 ORDER BY m.child_order`)
      .all({ viewer: viewer.id }) as ProjectRow[];
    res.json({ results: rows.map(projectShape), next_cursor: null });
  });

  router.add('GET', '/api/v1/projects/archived', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const rows = db.prepare(`${PROJECT_SELECT} WHERE p.is_deleted = 0 AND p.is_archived = 1 ORDER BY m.child_order`)
      .all({ viewer: viewer.id }) as ProjectRow[];
    res.json({ results: rows.map(projectShape), next_cursor: null });
  });

  const workspaceProjectsRoute = (archived: boolean) => (req: Request, res: Response) => {
    const viewer = viewerOf(req);
    const rows = db.prepare(`${PROJECT_SELECT} WHERE p.is_deleted = 0 AND p.is_archived = @archived AND p.workspace_id = @workspace ORDER BY m.child_order`)
      .all({ viewer: viewer.id, workspace: req.params.id, archived: archived ? 1 : 0 }) as ProjectRow[];
    res.json({ workspace_projects: rows.map(projectShape), next_cursor: null, has_more: false });
  };
  router.add('GET', '/api/v1/workspaces/:id/projects/active', 'bearer', workspaceProjectsRoute(false));
  router.add('GET', '/api/v1/workspaces/:id/projects/archived', 'bearer', workspaceProjectsRoute(true));

  router.add('POST', '/api/v1/projects', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = bodyOf(req);
    const args: Args = { ...body };
    const temps = applyDirect(db, viewer, 'project_add', args, temp);
    res.json(projectOutFor(db, viewer, temps.get(temp) ?? ''));
  });

  router.add('POST', '/api/v1/projects/move_to_workspace', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const body = bodyOf(req);
    applyDirect(db, viewer, 'project_move_to_workspace', { project_id: body.project_id, workspace_id: body.workspace_id });
    res.json({ project: projectOutFor(db, viewer, String(body.project_id)) });
  });

  router.add('POST', '/api/v1/projects/move_to_personal', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const body = bodyOf(req);
    applyDirect(db, viewer, 'project_move_to_personal', { project_id: body.project_id });
    res.json({ project: projectOutFor(db, viewer, String(body.project_id)) });
  });

  // Find a project by part of its name, among the active projects the person can see. Before `:id`, which would take “search” for an id.
  router.add('GET', '/api/v1/projects/search', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const query = req.query.get('query') ?? '';
    const { cursor, limit } = pageOf(req);
    const rows = (db.prepare(`${PROJECT_SELECT} WHERE p.is_deleted = 0 AND p.is_archived = 0 ORDER BY m.child_order`)
      .all({ viewer: viewer.id }) as ProjectRow[]).filter((row) => nameMatches(row.name, query));
    res.json({
      results: rows.slice(cursor, cursor + limit).map(projectShape),
      next_cursor: rows.length > cursor + limit ? String(cursor + limit) : null,
    });
  });

  router.add('GET', '/api/v1/projects/:id', 'bearer', (req, res) => {
    res.json(projectOutFor(db, viewerOf(req), req.params.id));
  });

  router.add('POST', '/api/v1/projects/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'project_update', { ...bodyOf(req), id: req.params.id });
    res.json(projectOutFor(db, viewer, req.params.id));
  });

  router.add('DELETE', '/api/v1/projects/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'project_delete', { id: req.params.id });
    res.empty();
  });

  router.add('POST', '/api/v1/projects/:id/archive', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'project_archive', { id: req.params.id });
    res.json(projectOutFor(db, viewer, req.params.id));
  });

  router.add('POST', '/api/v1/projects/:id/unarchive', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'project_unarchive', { id: req.params.id });
    res.json(projectOutFor(db, viewer, req.params.id));
  });

  router.add('GET', '/api/v1/projects/:id/collaborators', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    projectRow(db, viewer.id, req.params.id);
    const people = db.prepare(`SELECT u.id, u.email, u.full_name, u.image_id, u.timezone FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? AND m.state = 'active' ORDER BY m.child_order`).all(req.params.id) as Array<{ id: string; email: string; full_name: string; image_id: string | null; timezone: string }>;
    res.json({ results: people.map(collaboratorShape), next_cursor: null });
  });

  /* Sections ---------------------------------------------------------- */

  router.add('GET', '/api/v1/sections', 'bearer', (req, res) => {
    const rows = visibleSections(db, viewerOf(req), req.query.get('project_id'));
    res.json({ results: rows.map((row) => sectionShape(row, row.owner, row.project_created)), next_cursor: null });
  });

  // Sections by name, with the same wildcards as the project search, a page at a time. Registered before /:id.
  router.add('GET', '/api/v1/sections/search', 'bearer', (req, res) => {
    const query = searchQueryOf(req);
    const page = pageOf(req);
    const rows = visibleSections(db, viewerOf(req), req.query.get('project_id'), { query, page });
    res.json(pageFromRows(rows, page, (row) => sectionShape(row, row.owner, row.project_created)));
  });

  router.add('POST', '/api/v1/sections', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'section_add', { ...bodyOf(req) }, temp);
    res.json(sectionOut(viewer, db, temps.get(temp) ?? ''));
  });

  router.add('GET', '/api/v1/sections/:id', 'bearer', (req, res) => {
    res.json(sectionOut(viewerOf(req), db, req.params.id));
  });

  router.add('POST', '/api/v1/sections/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'section_update', { ...bodyOf(req), id: req.params.id });
    res.json(sectionOut(viewer, db, req.params.id));
  });

  router.add('DELETE', '/api/v1/sections/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'section_delete', { id: req.params.id });
    res.empty();
  });

  router.add('POST', '/api/v1/sections/:id/archive', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'section_archive', { id: req.params.id });
    res.json(sectionOut(viewer, db, req.params.id));
  });

  router.add('POST', '/api/v1/sections/:id/unarchive', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'section_unarchive', { id: req.params.id });
    res.json(sectionOut(viewer, db, req.params.id));
  });

  /* Labels ------------------------------------------------------------ */

  router.add('GET', '/api/v1/labels', 'bearer', (req, res) => {
    const page = pageOf(req);
    res.json(pageFromRows(labelPage(db, viewerOf(req).id, page), page, labelShape));
  });

  // What the official find-labels reads: personal labels by name, and the names of shared labels. Both are pages, and
  // both are registered before /:id.
  router.add('GET', '/api/v1/labels/search', 'bearer', (req, res) => {
    const query = searchQueryOf(req);
    const page = pageOf(req);
    res.json(pageFromRows(labelPage(db, viewerOf(req).id, page, query), page, labelShape));
  });

  router.add('GET', '/api/v1/labels/shared', 'bearer', (req, res) => {
    const omitPersonal = req.query.get('omit_personal') === 'true';
    res.json(pageOfList(sharedLabelNames(db, viewerOf(req).id, omitPersonal), pageOf(req), (name) => name));
  });

  router.add('POST', '/api/v1/labels', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'label_add', { ...bodyOf(req) }, temp);
    res.json(labelOutFor(viewer, db, temps.get(temp) ?? ''));
  });

  router.add('GET', '/api/v1/labels/:id', 'bearer', (req, res) => {
    res.json(labelOutFor(viewerOf(req), db, req.params.id));
  });

  router.add('POST', '/api/v1/labels/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'label_update', { ...bodyOf(req), id: req.params.id });
    res.json(labelOutFor(viewer, db, req.params.id));
  });

  router.add('DELETE', '/api/v1/labels/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'label_delete', { id: req.params.id });
    res.empty();
  });

  router.add('POST', '/api/v1/labels/shared/rename', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const body = bodyOf(req);
    const from = typeof body.name === 'string' ? body.name : '';
    const to = typeof body.new_name === 'string' ? body.new_name.trim() : '';
    if (!from || !to || to.length > MAX_NAME) throw ApiFailure.badRequest('Name the label and its new name.', 'INVALID_ARGUMENT');
    // One transaction: a rename that fails part way leaves no label half renamed.
    db.transaction(() => renameOnItems(makeCtx(db, viewer), from, to))();
    res.empty();
  });

  /* Comments ---------------------------------------------------------- */

  router.add('GET', '/api/v1/comments', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const task = req.query.get('task_id');
    const project = req.query.get('project_id');
    if (!task && !project) throw ApiFailure.badRequest('Name the task or the project whose comments you want.', 'INVALID_ARGUMENT');
    // The task or project must be one the person can see; only then is its comment list read, a page at a time.
    if (task) itemRow(db, viewer.id, task);
    else projectRow(db, viewer.id, project ?? '');
    const { cursor, limit } = pageOf(req);
    const rows = (task
      ? db.prepare('SELECT * FROM notes WHERE item_id = ? AND is_deleted = 0 ORDER BY posted_at, id LIMIT ? OFFSET ?').all(task, limit + 1, cursor)
      : db.prepare('SELECT * FROM notes WHERE project_id = ? AND item_id IS NULL AND is_deleted = 0 ORDER BY posted_at, id LIMIT ? OFFSET ?').all(project, limit + 1, cursor)) as NoteRow[];
    res.json({
      results: rows.slice(0, limit).map((row) => commentShape(db, row)),
      next_cursor: rows.length > limit ? String(cursor + limit) : null,
    });
  });

  router.add('POST', '/api/v1/comments', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = bodyOf(req);
    const args: Args = { content: body.content };
    if (typeof body.task_id === 'string') args.item_id = body.task_id;
    if (typeof body.project_id === 'string') args.project_id = body.project_id;
    if (body.attachment ?? body.file_attachment) args.file_attachment = body.attachment ?? body.file_attachment;
    const temps = applyDirect(db, viewer, 'note_add', args, temp);
    res.json(commentOutFor(viewer, db, temps.get(temp) ?? ''));
  });

  router.add('GET', '/api/v1/comments/:id', 'bearer', (req, res) => {
    res.json(commentOutFor(viewerOf(req), db, req.params.id));
  });

  router.add('POST', '/api/v1/comments/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'note_update', { ...bodyOf(req), id: req.params.id });
    res.json(commentOutFor(viewer, db, req.params.id));
  });

  router.add('DELETE', '/api/v1/comments/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'note_delete', { id: req.params.id });
    res.empty();
  });

  /* Activity ---------------------------------------------------------- */

  router.add('GET', '/api/v1/activities', 'bearer', (req, res) => {
    const cursor = req.query.get('cursor');
    if (cursor !== null && !/^\d{1,15}$/.test(cursor)) throw ApiFailure.badRequest('That cursor is not one this server gave.', 'INVALID_ARGUMENT');
    const { limit } = pageOf(req);
    res.json(listActivity(db, viewerOf(req), {
      object_type: req.query.get('object_type'),
      object_id: req.query.get('object_id'),
      event_type: req.query.get('event_type'),
      parent_project_id: req.query.get('parent_project_id'),
      parent_item_id: req.query.get('parent_item_id'),
      initiator_id: req.query.get('initiator_id'),
    }, cursor !== null ? Number(cursor) : Number.MAX_SAFE_INTEGER, limit));
  });

  /* Reminders --------------------------------------------------------- */

  const reminderArgs = (body: Record<string, unknown>): Args => {
    const args: Args = {};
    if ('task_id' in body) args.item_id = body.task_id;
    if ('reminder_type' in body) args.type = body.reminder_type;
    for (const key of ['minute_offset', 'due', 'notify_uid', 'service', 'is_urgent']) if (key in body) args[key] = body[key];
    return args;
  };
  const locationArgs = (body: Record<string, unknown>): Args => {
    const args: Args = {};
    if ('task_id' in body) args.item_id = body.task_id;
    for (const key of ['name', 'loc_lat', 'loc_long', 'loc_trigger', 'radius', 'notify_uid']) if (key in body) args[key] = body[key];
    return args;
  };
  const reminderOutFor = (viewer: UserRow, id: string) => {
    const row = visibleReminder(db, viewer.id, id);
    if (!row) throw ApiFailure.notFound('That reminder does not exist.', 'REMINDER_NOT_FOUND');
    return reminderApiShape(row);
  };
  const locationOutFor = (viewer: UserRow, id: string) => {
    const row = visibleLocationReminder(db, viewer.id, id);
    if (!row) throw ApiFailure.notFound('That location reminder does not exist.', 'REMINDER_NOT_FOUND');
    return locationReminderApiShape(row);
  };

  router.add('GET', '/api/v1/reminders', 'bearer', (req, res) => {
    res.json({ results: reminderList(db, viewerOf(req).id).map(reminderApiShape), next_cursor: null });
  });
  router.add('POST', '/api/v1/reminders', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'reminder_add', reminderArgs(bodyOf(req)), temp);
    res.json(reminderOutFor(viewer, temps.get(temp) ?? ''));
  });
  router.add('GET', '/api/v1/reminders/:id', 'bearer', (req, res) => {
    res.json(reminderOutFor(viewerOf(req), req.params.id));
  });
  router.add('POST', '/api/v1/reminders/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'reminder_update', { ...reminderArgs(bodyOf(req)), id: req.params.id });
    res.json(reminderOutFor(viewer, req.params.id));
  });
  router.add('DELETE', '/api/v1/reminders/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'reminder_delete', { id: req.params.id });
    res.empty();
  });

  router.add('GET', '/api/v1/location_reminders', 'bearer', (req, res) => {
    res.json({ results: locationReminderList(db, viewerOf(req).id).map(locationReminderApiShape), next_cursor: null });
  });
  router.add('POST', '/api/v1/location_reminders', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'location_reminder_add', locationArgs(bodyOf(req)), temp);
    res.json(locationOutFor(viewer, temps.get(temp) ?? ''));
  });
  router.add('GET', '/api/v1/location_reminders/:id', 'bearer', (req, res) => {
    res.json(locationOutFor(viewerOf(req), req.params.id));
  });
  router.add('POST', '/api/v1/location_reminders/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'location_reminder_update', { ...locationArgs(bodyOf(req)), id: req.params.id });
    res.json(locationOutFor(viewer, req.params.id));
  });
  router.add('DELETE', '/api/v1/location_reminders/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'location_reminder_delete', { id: req.params.id });
    res.empty();
  });

  /* Insights and productivity ----------------------------------------- */

  router.add('GET', '/api/v1/tasks/completed/stats', 'bearer', (req, res) => {
    res.json(productivityOf(db, viewerOf(req)));
  });

  router.add('GET', '/api/v1/projects/:id/insights/progress', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    projectRow(db, viewer.id, req.params.id);
    res.json(progressOf(db, viewer, req.params.id));
  });

  router.add('GET', '/api/v1/projects/:id/insights/health', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    projectRow(db, viewer.id, req.params.id);
    res.json(healthOf(db, viewer, req.params.id));
  });

  router.add('POST', '/api/v1/projects/:id/insights/health/analyze', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    projectRow(db, viewer.id, req.params.id);
    res.json(healthOf(db, viewer, req.params.id));
  });

  router.add('GET', '/api/v1/projects/:id/insights/activity_stats', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    projectRow(db, viewer.id, req.params.id);
    res.json(activityStatsOf(db, viewer, req.params.id));
  });

  router.add('GET', '/api/v1/workspaces/:id/insights', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    requireWorkspace(db, req.params.id, viewer.id);
    res.json(workspaceInsightsOf(db, viewer, req.params.id));
  });

  /* Templates ---------------------------------------------------------- */

  router.add('GET', '/api/v1/templates/file', 'bearer', (req, res) => {
    const project = req.query.get('project_id') ?? '';
    res.text(projectCsv(db, viewerOf(req), project), 'text/csv');
  });

  router.add('GET', '/api/v1/templates/url', 'bearer', (req, res) => {
    const project = req.query.get('project_id') ?? '';
    projectRow(db, viewerOf(req).id, project);
    res.json({ file_url: `/api/v1/templates/file?project_id=${encodeURIComponent(project)}` });
  });

  // Templates from Todoist's own library are not on this server; a template made here is imported as CSV.
  router.add('POST', '/api/v1/projects/:id/import_template', 'bearer', () => {
    throw ApiFailure.notFound('That template is not on this server. Import a CSV file instead.', 'TEMPLATE_NOT_FOUND');
  });

  /* Filters ----------------------------------------------------------- */

  const filterArgs = (body: Record<string, unknown>): Args => {
    const args: Args = {};
    for (const key of ['name', 'query', 'description', 'color', 'is_favorite', 'item_order', 'order_key']) if (key in body) args[key] = body[key];
    return args;
  };
  const filterOutFor = (viewer: UserRow, id: string) => {
    const row = db.prepare('SELECT * FROM filters WHERE id = ? AND user_id = ? AND is_deleted = 0').get(id, viewer.id) as Parameters<typeof filterOut>[0] | undefined;
    if (!row) throw ApiFailure.notFound('That filter does not exist.', 'FILTER_NOT_FOUND');
    return filterOut(row);
  };

  router.add('GET', '/api/v1/filters', 'bearer', (req, res) => {
    const rows = db.prepare('SELECT * FROM filters WHERE user_id = ? AND is_deleted = 0 ORDER BY item_order').all(viewerOf(req).id);
    res.json({ results: (rows as Parameters<typeof filterOut>[0][]).map(filterOut), next_cursor: null });
  });
  router.add('POST', '/api/v1/filters', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'filter_add', filterArgs(bodyOf(req)), temp);
    res.json(filterOutFor(viewer, temps.get(temp) ?? ''));
  });
  router.add('GET', '/api/v1/filters/:id', 'bearer', (req, res) => {
    res.json(filterOutFor(viewerOf(req), req.params.id));
  });
  router.add('POST', '/api/v1/filters/:id', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    applyDirect(db, viewer, 'filter_update', { ...filterArgs(bodyOf(req)), id: req.params.id });
    res.json(filterOutFor(viewer, req.params.id));
  });
  router.add('DELETE', '/api/v1/filters/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'filter_delete', { id: req.params.id });
    res.empty();
  });

  /* Joining ----------------------------------------------------------- */

  // A project in a workspace can be joined by someone it was shared with: their pending invitation is accepted.
  router.add('POST', '/api/v1/projects/:id/join', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ? AND is_deleted = 0').get(req.params.id) as { workspace_id: string | null } | undefined;
    const invite = db.prepare(`SELECT id, secret FROM invitations WHERE kind = 'project' AND project_id = @project AND state = 'pending'
      AND (user_id = @viewer OR (user_id IS NULL AND lower(email) = lower(@email))) ORDER BY created_at DESC LIMIT 1`)
      .get({ project: req.params.id, viewer: viewer.id, email: viewer.email }) as { id: string; secret: string } | undefined;
    if (!project || !invite) throw ApiFailure.forbidden('That project is not open to you to join.', 'NOT_JOINABLE');
    if (!project.workspace_id) throw ApiFailure.badRequest('Only a project in a workspace is joined this way.', 'NOT_IN_WORKSPACE');
    applyDirect(db, viewer, 'accept_invitation', { invitation_id: invite.id, invitation_secret: invite.secret });
    const row = projectRow(db, viewer.id, req.params.id);
    const tasks = db.prepare('SELECT * FROM items WHERE project_id = ? AND is_deleted = 0 AND checked = 0 ORDER BY child_order').all(row.id) as ItemRow[];
    const sections = db.prepare('SELECT s.*, p.created_at AS project_created, p.created_by AS owner FROM sections s JOIN projects p ON p.id = s.project_id WHERE s.project_id = ? AND s.is_deleted = 0 ORDER BY s.section_order')
      .all(row.id) as SectionWithProject[];
    const people = db.prepare(`SELECT u.id, u.email, u.full_name, u.image_id, u.timezone FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? AND m.state = 'active'`).all(row.id) as Array<{ id: string; email: string; full_name: string; image_id: string | null; timezone: string }>;
    const subprojects = db.prepare(`${PROJECT_SELECT} WHERE p.is_deleted = 0 AND p.parent_id = @project`)
      .all({ viewer: viewer.id, project: row.id }) as ProjectRow[];
    const folder = row.folder_id ? visibleFolder(db, viewer, row.folder_id) : undefined;
    res.json({
      project: projectShape(row),
      tasks: tasks.map((task) => taskShape(task, 0)),
      sections: sections.map((section) => sectionShape(section, section.owner, section.project_created)),
      comments: [],
      collaborators: people.map(collaboratorShape),
      collaborator_states: [],
      folder: folder ? folderShape(folder) : null,
      subprojects: subprojects.map(projectShape),
    });
  });

  /* Folders and workspaces -------------------------------------------- */

  router.add('GET', '/api/v1/folders', 'bearer', (req, res) => {
    const workspace = req.query.get('workspace_id');
    const rows = db.prepare(`SELECT f.* FROM folders f WHERE f.is_deleted = 0 AND f.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = @viewer)
      AND (@workspace IS NULL OR f.workspace_id = @workspace)`)
      .all({ viewer: viewerOf(req).id, workspace });
    res.json({ results: (rows as Parameters<typeof folderShape>[0][]).map(folderShape), next_cursor: null });
  });

  router.add('POST', '/api/v1/folders', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temps = applyDirect(db, viewer, 'folder_add', { ...bodyOf(req) }, temp);
    res.json(folderOutFor(db, viewerOf(req), temps.get(temp) ?? ''));
  });

  router.add('GET', '/api/v1/folders/:id', 'bearer', (req, res) => {
    res.json(folderOutFor(db, viewerOf(req), req.params.id));
  });

  router.add('POST', '/api/v1/folders/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'folder_update', { ...bodyOf(req), id: req.params.id });
    res.json(folderOutFor(db, viewerOf(req), req.params.id));
  });

  router.add('DELETE', '/api/v1/folders/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'folder_delete', { id: req.params.id });
    res.empty();
  });

  router.add('GET', '/api/v1/workspaces', 'bearer', (req, res) => {
    const rows = db.prepare(`SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND w.is_deleted = 0`).all(viewerOf(req).id);
    res.json((rows as Array<Parameters<typeof workspaceApiShape>[0]>).map(workspaceApiShape));
  });

}

/** The completed tasks the REST API lists, one page at a time. */
function completedPage(db: Db, viewer: UserRow, req: Request, dateColumn: 'completed_at' | 'due_date') {
  const since = req.query.get('since');
  const until = req.query.get('until');
  if (since && until && since > until) throw ApiFailure.badRequest('The range starts after it ends.', 'INVALID_DATE');
  const { cursor, limit } = pageOf(req);
  const where = ['i.checked = 1', 'i.is_deleted = 0', visibleSql('i.project_id')];
  const params: Record<string, unknown> = { viewer: viewer.id };
  if (since) { where.push(`i.${dateColumn} >= @since`); params.since = since; }
  if (until) { where.push(`i.${dateColumn} <= @until`); params.until = until; }
  const rows = db.prepare(`SELECT i.* FROM items i WHERE ${where.join(' AND ')} ORDER BY i.completed_at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: limit + 1, offset: cursor }) as ItemRow[];
  const page = rows.slice(0, limit);
  const counts = noteCounts(db, page.map((row) => row.id));
  return {
    items: page.map((row) => taskShape(row, counts.get(row.id) ?? 0)),
    next_cursor: rows.length > limit ? String(cursor + limit) : null,
  };
}

type SectionWithProject = Parameters<typeof sectionShape>[0] & { project_created: string | null; owner: string };

function sectionOut(viewer: UserRow, db: Db, id: string) {
  const row = db.prepare(`SELECT s.*, p.created_at AS project_created, p.created_by AS owner FROM sections s JOIN projects p ON p.id = s.project_id
    WHERE s.id = @id AND s.is_deleted = 0 AND s.project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active')`)
    .get({ id, viewer: viewer.id }) as SectionWithProject | undefined;
  if (!row) throw ApiFailure.notFound('That section does not exist.', 'SECTION_NOT_FOUND');
  return sectionShape(row, row.owner, row.project_created);
}

function labelOutFor(viewer: UserRow, db: Db, id: string) {
  const row = db.prepare('SELECT * FROM labels WHERE id = ? AND user_id = ? AND is_deleted = 0').get(id, viewer.id) as Parameters<typeof labelShape>[0] | undefined;
  if (!row) throw ApiFailure.notFound('That label does not exist.', 'LABEL_NOT_FOUND');
  return labelShape(row);
}

function commentOutFor(viewer: UserRow, db: Db, id: string) {
  const row = loadNote(makeCtx(db, viewer), id, 'read').row;
  return commentShape(db, row);
}

/** A folder row, if its workspace is one the person is in. Nothing else about a folder is ever returned. */
function visibleFolder(db: Db, viewer: UserRow, id: string) {
  return db.prepare(`SELECT f.* FROM folders f WHERE f.id = @id AND f.is_deleted = 0
    AND f.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = @viewer)`)
    .get({ id, viewer: viewer.id }) as Parameters<typeof folderShape>[0] | undefined;
}

/** The folder the API returns; for one the person cannot see, the answer is the same as for a folder that does not exist. */
function folderOutFor(db: Db, viewer: UserRow, id: string) {
  const row = visibleFolder(db, viewer, id);
  if (!row) throw ApiFailure.notFound('That folder does not exist.', 'FOLDER_NOT_FOUND');
  return folderShape(row);
}

/** The objects a CSV import made, in the shape the API returns them. */
export function importAnswer(db: Db, viewer: UserRow, projectId: string | null, text: string) {
  const made = importCsv(db, viewer, projectId, text);
  return {
    projects: made.project ? [projectShape(projectRow(db, viewer.id, made.project))] : [],
    sections: made.sections.map((id) => sectionOut(viewer, db, id)),
    tasks: made.tasks.map((id) => taskOutFor(db, viewer, id)),
    comments: made.comments.map((id) => commentOutFor(viewer, db, id)),
  };
}

function taskOutFor(db: Db, viewer: UserRow, id: string) {
  const row = itemRow(db, viewer.id, id);
  return taskShape(row, noteCounts(db, [row.id]).get(row.id) ?? 0);
}
