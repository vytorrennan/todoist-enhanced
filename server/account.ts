import { ApiFailure, type Db, nextSeq } from './db';
import { type Args, type Ctx, id as idArg, integer, resolveId, text, truthy } from './ctx';
import { answerInvitation } from './sharing';
import { cleanName, cleanTimezone } from './auth';
import { touchUser } from './sharing';

/** A person's own settings, their notifications, and their answers to invitations. */

export function updateUser(ctx: Ctx, args: Args): void {
  const { db, viewer } = ctx;
  const set: Record<string, unknown> = {};
  if ('full_name' in args) set.full_name = cleanName(args.full_name);
  if ('timezone' in args) {
    const zone = cleanTimezone(args.timezone);
    if (!zone) throw ApiFailure.badRequest('That timezone is not one the server knows.', 'INVALID_TIMEZONE');
    set.timezone = zone;
  }
  if ('lang' in args) {
    if (args.lang !== 'en' && args.lang !== 'fr') throw ApiFailure.badRequest('The language is en or fr.', 'INVALID_LANGUAGE');
    set.lang = args.lang;
  }
  if ('start_day' in args) {
    const day = integer(args, 'start_day', { min: 1, max: 7 });
    if (day === undefined) throw ApiFailure.badRequest('The first day of the week is 1 to 7.');
    set.start_day = day;
  }
  if ('reset_recurring_subtasks' in args) set.reset_recurring_subtasks = truthy(args.reset_recurring_subtasks) ? 1 : 0;
  const keys = Object.keys(set);
  if (!keys.length) return;
  db.prepare(`UPDATE users SET ${keys.map((key) => `${key} = @${key}`).join(', ')}, seq = @seq WHERE id = @id`)
    .run({ ...set, seq: nextSeq(db), id: viewer.id });
  touchUser(db, viewer.id);
}

function setUnread(db: Db, viewerId: string, ids: string[] | null, unread: boolean): void {
  const seq = nextSeq(db);
  if (ids === null) {
    db.prepare('UPDATE notifications SET is_unread = ?, seq = ? WHERE user_id = ? AND is_deleted = 0 AND is_unread != ?')
      .run(unread ? 1 : 0, seq, viewerId, unread ? 1 : 0);
    return;
  }
  const update = db.prepare('UPDATE notifications SET is_unread = ?, seq = ? WHERE id = ? AND user_id = ?');
  for (const id of ids) update.run(unread ? 1 : 0, nextSeq(db), id, viewerId);
}

export const ACCOUNT_COMMANDS = {
  user_update: (ctx: Ctx, args: Args) => updateUser(ctx, args),
  live_notifications_mark_read: (ctx: Ctx, args: Args) => setUnread(ctx.db, ctx.viewer.id, idList(args.ids), false),
  live_notifications_mark_unread: (ctx: Ctx, args: Args) => setUnread(ctx.db, ctx.viewer.id, idList(args.ids), true),
  live_notifications_mark_read_all: (ctx: Ctx) => setUnread(ctx.db, ctx.viewer.id, null, false),
  accept_invitation: (ctx: Ctx, args: Args) => answerInvitation(ctx, resolveId(ctx, idArg(args, 'invitation_id', true)), text(args, 'invitation_secret', { required: true }) ?? '', true),
  reject_invitation: (ctx: Ctx, args: Args) => answerInvitation(ctx, resolveId(ctx, idArg(args, 'invitation_id', true)), text(args, 'invitation_secret', { required: true }) ?? '', false),
};

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) throw ApiFailure.badRequest('“ids” must be a list.');
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200);
}

export type { Ctx };
