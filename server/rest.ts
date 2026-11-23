import type { Db } from './db';
import { ApiFailure } from './db';
import type { UserRow } from './auth';
import type { Request, Response, Router } from './http';
import { applyDirect } from './commands';
import { visibleSql } from './access';
import { type Args, makeCtx } from './ctx';
import { filterPage, renameOnItems } from './labels';
import { loadNote } from './notes';
import { todayIn } from './dates';
import { readNaturalDate } from '../src/domain/nlp';
import { ruleFromString } from '../src/domain/repeatRule';
import { collaboratorShape, commentShape, folderShape, labelShape, projectShape, sectionShape, taskShape, userApiShape, workspaceApiShape } from './rest-shapes';
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

function pageOf(req: Request): { cursor: number; limit: number } {
  const cursor = Number(req.query.get('cursor') ?? 0);
  const limit = Number(req.query.get('limit') ?? DEFAULT_LIMIT);
  return {
    cursor: Number.isInteger(cursor) && cursor >= 0 ? cursor : 0,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
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
  // A repeat rule is kept as written; anything else is read as a day, from the viewer's today.
  if (ruleFromString(words) && /\b(every|tous les|chaque|tout les)\b/i.test(words)) {
    return { ...due, string: words, is_recurring: true };
  }
  const reading = readNaturalDate(words, new Date(`${todayIn(viewer.timezone)}T12:00:00`), { locale: viewer.lang === 'fr' ? 'fr' : 'en' });
  if (!reading) throw ApiFailure.badRequest(`“${words}” is not a date the server can read.`, 'INVALID_DATE');
  return { ...due, date: reading.date, string: words };
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
      where.push('EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = @label)');
      params.label = label;
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
    const people = db.prepare(`SELECT u.id, u.email, u.full_name, u.image_id FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? AND m.state = 'active' ORDER BY m.child_order`).all(req.params.id) as Array<{ id: string; email: string; full_name: string; image_id: string | null }>;
    res.json({ results: people.map(collaboratorShape), next_cursor: null });
  });

  /* Sections ---------------------------------------------------------- */

  router.add('GET', '/api/v1/sections', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const project = req.query.get('project_id');
    const where = [`s.is_deleted = 0`, visibleSql('s.project_id')];
    const params: Record<string, unknown> = { viewer: viewer.id };
    if (project) { where.push('s.project_id = @project'); params.project = project; }
    const rows = db.prepare(`SELECT s.*, p.created_at AS project_created, p.created_by AS owner FROM sections s JOIN projects p ON p.id = s.project_id
      WHERE ${where.join(' AND ')} ORDER BY s.project_id, s.section_order`).all(params) as SectionWithProject[];
    res.json({ results: rows.map((row) => sectionShape(row, row.owner, row.project_created)), next_cursor: null });
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
    const rows = db.prepare('SELECT * FROM labels WHERE user_id = ? AND is_deleted = 0 ORDER BY item_order').all(viewerOf(req).id);
    res.json({ results: (rows as Parameters<typeof labelShape>[0][]).map(labelShape), next_cursor: null });
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
    const to = typeof body.new_name === 'string' ? body.new_name : '';
    if (!from || !to) throw ApiFailure.badRequest('Name the label and its new name.', 'INVALID_ARGUMENT');
    renameOnItems(makeCtx(db, viewer), from, to);
    res.empty();
  });

  /* Comments ---------------------------------------------------------- */

  router.add('GET', '/api/v1/comments', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const task = req.query.get('task_id');
    const project = req.query.get('project_id');
    const { cursor, limit } = pageOf(req);
    if (!task && !project) throw ApiFailure.badRequest('Name the task or the project whose comments you want.', 'INVALID_ARGUMENT');
    const ctx = makeCtx(db, viewer);
    const rows = task
      ? db.prepare('SELECT * FROM notes WHERE item_id = ? AND is_deleted = 0 ORDER BY posted_at LIMIT ? OFFSET ?').all(task, limit, cursor)
      : project
        ? db.prepare('SELECT * FROM notes WHERE project_id = ? AND item_id IS NULL AND is_deleted = 0 ORDER BY posted_at LIMIT ? OFFSET ?').all(project, limit, cursor)
        : [];
    const visible = (rows as NoteRow[]).filter((row) => {
      try {
        loadNote(ctx, row.id, 'read');
        return true;
      } catch {
        return false;
      }
    });
    res.json({ results: visible.map((row) => commentShape(db, row)), next_cursor: null });
  });

  router.add('POST', '/api/v1/comments', 'bearer', (req, res) => {
    const viewer = viewerOf(req);
    const temp = `rest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = bodyOf(req);
    const args: Args = { content: body.content };
    if (typeof body.task_id === 'string') args.item_id = body.task_id;
    if (typeof body.project_id === 'string') args.project_id = body.project_id;
    if (body.attachment) args.attachment = body.attachment;
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
    res.json(folderOutFor(db, temps.get(temp) ?? ''));
  });

  router.add('GET', '/api/v1/folders/:id', 'bearer', (req, res) => {
    res.json(folderOutFor(db, req.params.id));
  });

  router.add('POST', '/api/v1/folders/:id', 'bearer', (req, res) => {
    applyDirect(db, viewerOf(req), 'folder_update', { ...bodyOf(req), id: req.params.id });
    res.json(folderOutFor(db, req.params.id));
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

function folderOutFor(db: Db, id: string) {
  const row = db.prepare('SELECT * FROM folders WHERE id = ? AND is_deleted = 0').get(id) as Parameters<typeof folderShape>[0] | undefined;
  if (!row) throw ApiFailure.notFound('That folder does not exist.', 'FOLDER_NOT_FOUND');
  return folderShape(row);
}

