import { ApiFailure, type Db, newId, nextSeq, nowIso } from './db';
import { requireProject, visibleSql, VISIBLE_PROJECT_SQL } from './access';
import { type Args, type Ctx, id as idArg, resolveId, text } from './ctx';
import { loadItem } from './items';
import { type NoteRow, noteOut } from './serialize';
import { pageOf } from './projects';

/** Comments on tasks and on projects, their attachments, and reactions. */

export const MAX_COMMENT = 15_000;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3|\p{Extended_Pictographic}|\p{Regional_Indicator})*$/u;

/** The one kind of attachment a comment can carry: a file this person uploaded. */
const FILE_URL = /^\/api\/v1\/files\/([0-9a-f]{32})$/;

interface AttachmentInput { file_name?: unknown; file_type?: unknown; file_size?: unknown; file_url?: unknown; resource_type?: unknown; upload_state?: unknown }

function cleanAttachment(ctx: Ctx, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw ApiFailure.badRequest('The attachment is not a file.', 'INVALID_ATTACHMENT');
  const input = raw as AttachmentInput;
  const url = typeof input.file_url === 'string' ? FILE_URL.exec(input.file_url) : null;
  if (!url) throw ApiFailure.badRequest('The attachment is not a file this app uploaded.', 'INVALID_ATTACHMENT');
  const file = ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(url[1]) as
    | { id: string; owner_id: string; file_name: string; file_type: string; file_size: number } | undefined;
  if (!file || file.owner_id !== ctx.viewer.id) throw ApiFailure.badRequest('Only the file’s owner can attach it.', 'INVALID_ATTACHMENT');
  return JSON.stringify({
    file_name: file.file_name,
    file_type: file.file_type,
    file_size: file.file_size,
    file_url: input.file_url,
    resource_type: file.file_type.startsWith('image/') ? 'image' : 'file',
    upload_state: 'completed',
  });
}

/** A comment and the project it belongs to, if the viewer can see it. */
export function loadNote(ctx: Ctx, noteId: string, need: 'read' | 'write' = 'read') {
  const row = ctx.db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
  if (!row || row.is_deleted) throw ApiFailure.notFound('That comment does not exist.', 'NOTE_NOT_FOUND');
  const projectId = row.item_id
    ? loadItem(ctx, row.item_id).project_id
    : row.project_id;
  if (!projectId) throw ApiFailure.notFound('That comment does not exist.', 'NOTE_NOT_FOUND');
  requireProject(ctx.db, projectId, ctx.viewer.id, need);
  return { row, projectId };
}

export function addNote(ctx: Ctx, args: Args, tempId?: string): void {
  const { db, viewer } = ctx;
  const itemId = idArg(args, 'item_id');
  const projectArg = idArg(args, 'project_id');
  if (!itemId && !projectArg) throw ApiFailure.badRequest('A comment belongs to a task or a project.', 'INVALID_ARGUMENT');
  let itemRow: string | null = null;
  let projectRow: string | null = null;
  if (itemId) {
    const item = loadItem(ctx, resolveId(ctx, itemId));
    requireProject(db, item.project_id, viewer.id, 'write');
    itemRow = item.id;
  } else {
    projectRow = resolveId(ctx, projectArg);
    requireProject(db, projectRow, viewer.id, 'write');
  }
  const content = text(args, 'content', { max: MAX_COMMENT }) ?? '';
  const attachment = cleanAttachment(ctx, args.file_attachment);
  if (!content.trim() && !attachment) throw ApiFailure.badRequest('A comment needs some text or a file.', 'EMPTY_COMMENT');
  const id = newId();
  if (tempId) ctx.temps.set(tempId, id);
  db.prepare(`INSERT INTO notes (id, item_id, project_id, content, posted_at, posted_by, file_attachment, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, itemRow, itemRow ? null : projectRow, content, ctx.now, viewer.id, attachment, nextSeq(db));
}

export function updateNote(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const { row } = loadNote(ctx, resolveId(ctx, idArg(args, 'id', true)), 'read');
  if (row.posted_by !== viewer.id) throw ApiFailure.forbidden('Only the author can change a comment.', 'NOT_AUTHOR');
  const content = text(args, 'content', { max: MAX_COMMENT }) ?? '';
  if (!content.trim() && !row.file_attachment) throw ApiFailure.badRequest('A comment needs some text or a file.', 'EMPTY_COMMENT');
  db.prepare('UPDATE notes SET content = ?, seq = ? WHERE id = ?').run(content, nextSeq(db), row.id);
}

export function deleteNote(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const { row, projectId } = loadNote(ctx, resolveId(ctx, idArg(args, 'id', true)), 'read');
  if (row.posted_by !== viewer.id) requireProject(db, projectId, viewer.id, 'admin');
  db.prepare('UPDATE notes SET is_deleted = 1, seq = ? WHERE id = ?').run(nextSeq(db), row.id);
}

/** Adds or removes one person's reaction on a comment. Any person who can see the comment may react. */
export function setReaction(ctx: Ctx, noteId: string, reaction: unknown, on: boolean) {
  const { db, viewer } = ctx;
  const { row } = loadNote(ctx, noteId, 'read');
  if (typeof reaction !== 'string' || !EMOJI.test(reaction)) throw ApiFailure.badRequest('That reaction is not an emoji.', 'INVALID_REACTION');
  const changed = on
    ? db.prepare('INSERT OR IGNORE INTO note_reactions (note_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(row.id, viewer.id, reaction, nowIso()).changes
    : db.prepare('DELETE FROM note_reactions WHERE note_id = ? AND user_id = ? AND emoji = ?').run(row.id, viewer.id, reaction).changes;
  // The comment changed for everyone who reads it: its sequence moves, so an incremental read carries the reaction.
  if (changed > 0) db.prepare('UPDATE notes SET seq = ? WHERE id = ?').run(nextSeq(db), row.id);
  const fresh = db.prepare('SELECT * FROM notes WHERE id = ?').get(row.id) as NoteRow;
  return noteOut(db, fresh);
}

/** The comments on one task, or one project, oldest first, one page at a time. */
export function listComments(db: Db, viewerId: string, scope: { taskId?: string; projectId?: string }, cursor: string | undefined, limit = 200) {
  if (scope.taskId) {
    const rows = db.prepare(`SELECT n.* FROM notes n JOIN items i ON i.id = n.item_id
        WHERE n.item_id = @item AND n.is_deleted = 0 AND i.is_deleted = 0 AND ${visibleSql('i.project_id')}
        ORDER BY n.posted_at, n.id`).all({ item: scope.taskId, viewer: viewerId }) as NoteRow[];
    const page = pageOf(rows, cursor, limit);
    return { results: page.items.map((row) => noteOut(db, row)), next_cursor: page.next_cursor };
  }
  const rows = db.prepare(`SELECT * FROM notes WHERE project_id = @project AND item_id IS NULL AND is_deleted = 0
      AND ${VISIBLE_PROJECT_SQL} ORDER BY posted_at, id`).all({ project: scope.projectId, viewer: viewerId }) as NoteRow[];
  const page = pageOf(rows, cursor, limit);
  return { results: page.items.map((row) => noteOut(db, row)), next_cursor: page.next_cursor };
}

export const NOTE_COMMANDS = {
  note_add: (ctx: Ctx, args: Args, temp?: string) => addNote(ctx, args, temp),
  note_update: (ctx: Ctx, args: Args) => updateNote(ctx, args),
  note_delete: (ctx: Ctx, args: Args) => deleteNote(ctx, args),
};
