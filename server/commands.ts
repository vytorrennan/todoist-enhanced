import { ApiFailure, type Db } from './db';
import type { UserRow } from './auth';
import { type Args, type Ctx, id as idArg, makeCtx, resolveId, text } from './ctx';
import { ITEM_COMMANDS } from './items';
import { addProject, archiveProject, deleteProject, moveProjectToPersonal, moveProjectToWorkspace, reorderProjects, updateProject, addSection, updateSection, archiveSection, moveSection, deleteSection } from './projects';
import { shareProject, removeFromProject, changeRole } from './sharing';
import { LABEL_COMMANDS } from './labels';
import { NOTE_COMMANDS } from './notes';
import { WORKSPACE_COMMANDS } from './workspaces';
import { ACCOUNT_COMMANDS } from './account';
import { readFor, RESOURCE_TYPES } from './read';
import { currentSeq } from './db';

/**
 * The write side of sync: a list of commands, each applied on its own, and the
 * changes that followed them.
 *
 * Every command has a uuid. A command the server has already answered is not
 * run again, so a request that was retried after a lost reply changes nothing
 * twice. A command that fails is refused alone; the others in the same
 * request still go through.
 */

export interface CommandInput {
  type: string;
  uuid: string;
  args?: Args;
  temp_id?: string;
}

export type CommandStatus = 'ok' | { error_code: number; error: string; error_tag: string };

type Handler = (ctx: Ctx, args: Args, temp?: string) => void;

const HANDLERS: Record<string, Handler> = {
  ...ITEM_COMMANDS,
  ...LABEL_COMMANDS,
  ...NOTE_COMMANDS,
  ...WORKSPACE_COMMANDS,
  ...ACCOUNT_COMMANDS,
  project_add: (ctx, args, temp) => addProject(ctx, args, temp),
  project_update: (ctx, args) => updateProject(ctx, args),
  project_reorder: (ctx, args) => reorderProjects(ctx, args),
  project_move: (ctx, args) => updateProject(ctx, { id: args.id, parent_id: args.parent_id ?? null }),
  project_archive: (ctx, args) => archiveProject(ctx, resolveId(ctx, idArg(args, 'id', true))),
  project_move_to_workspace: (ctx, args) => moveProjectToWorkspace(ctx, resolveId(ctx, idArg(args, 'project_id', true)), resolveId(ctx, idArg(args, 'workspace_id', true))),
  project_move_to_personal: (ctx, args) => moveProjectToPersonal(ctx, resolveId(ctx, idArg(args, 'project_id', true))),
  project_delete: (ctx, args) => deleteProject(ctx, resolveId(ctx, idArg(args, 'id', true))),
  share_project: (ctx, args) => shareProject(
    ctx,
    resolveId(ctx, idArg(args, 'project_id', true)),
    text(args, 'email', { required: true }) ?? '',
    typeof args.role === 'string' ? args.role : undefined,
  ),
  delete_collaborator: (ctx, args) => removeFromProject(ctx, resolveId(ctx, idArg(args, 'project_id', true)), text(args, 'email', { required: true }) ?? ''),
  project_change_role: (ctx, args) => changeRole(ctx, resolveId(ctx, idArg(args, 'id', true)), resolveId(ctx, idArg(args, 'user_id', true)), args.role),
  section_add: (ctx, args, temp) => addSection(ctx, args, temp),
  section_update: (ctx, args) => updateSection(ctx, args),
  section_archive: (ctx, args) => archiveSection(ctx, resolveId(ctx, idArg(args, 'id', true)), true),
  section_unarchive: (ctx, args) => archiveSection(ctx, resolveId(ctx, idArg(args, 'id', true)), false),
  section_move: (ctx, args) => moveSection(ctx, args),
  section_delete: (ctx, args) => deleteSection(ctx, resolveId(ctx, idArg(args, 'id', true))),
};

/** Every temporary id in the arguments, replaced by the real one made for it. */
function substitute(value: unknown, temps: Map<string, string>): unknown {
  if (typeof value === 'string') return temps.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => substitute(item, temps));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, temps)]));
  }
  return value;
}

function statusOf(error: unknown): Exclude<CommandStatus, 'ok'> {
  if (error instanceof ApiFailure) return { error_code: error.code, error: error.message, error_tag: error.tag };
  console.error('Command failed:', error);
  return { error_code: 500, error: 'The server could not do that. Nothing changed.', error_tag: 'INTERNAL' };
}

export interface CommandOutcome {
  sync_status: Record<string, CommandStatus>;
  temp_id_mapping: Record<string, string>;
}

/** Applies commands in order, each on its own, and says what became of each one. */
export function runCommands(db: Db, viewer: UserRow, commands: CommandInput[], now = new Date()): CommandOutcome {
  const ctx = makeCtx(db, viewer, now);
  const sync_status: Record<string, CommandStatus> = {};
  // Temporary ids whose creation failed with an internal error in this request. Anything that names one has nothing to
  // act on yet: it waits for a retry, and its answer is not stored, or the retry would replay a refusal for ever.
  const unfinished = new Set<string>();
  for (const command of commands) {
    const uuid = typeof command?.uuid === 'string' ? command.uuid : '';
    if (!uuid) continue;
    const prior = db.prepare('SELECT status FROM processed_commands WHERE uuid = ? AND user_id = ?').get(uuid, viewer.id) as { status: string } | undefined;
    if (prior) {
      // A retry gets the answer it got the first time, including the ids it was given.
      const kept = JSON.parse(prior.status) as { status: CommandStatus; temps: Array<[string, string]> };
      sync_status[uuid] = kept.status;
      for (const [temp, real] of kept.temps) ctx.temps.set(temp, real);
      continue;
    }
    if ([...unfinished].some((temp) => JSON.stringify(command.args ?? {}).includes(temp))) {
      sync_status[uuid] = { error_code: 503, error: 'It waits for a change that did not finish. Nothing changed.', error_tag: 'WAITS_FOR_RETRY' };
      // What it was to create waits too: a command that names it is deferred in turn.
      if (command.temp_id) unfinished.add(command.temp_id);
      continue;
    }
    const handler = typeof command.type === 'string' ? HANDLERS[command.type] : undefined;
    const before = new Map(ctx.temps);
    let status: CommandStatus;
    try {
      if (!handler) throw ApiFailure.badRequest(`The server does not know the command “${String(command.type)}”.`, 'UNKNOWN_COMMAND');
      const args = substitute(command.args ?? {}, ctx.temps) as Args;
      db.transaction(() => handler(ctx, args, command.temp_id))();
      status = 'ok';
    } catch (error) {
      // A refused command must leave no temporary id behind: nothing was made for it.
      ctx.temps.clear();
      for (const [key, value] of before) ctx.temps.set(key, value);
      status = statusOf(error);
    }
    sync_status[uuid] = status;
    // An internal failure is not an answer: the command stays eligible for a retry instead of being replayed forever.
    if (typeof status !== 'string' && status.error_code === 500 && command.temp_id) unfinished.add(command.temp_id);
    if (typeof status === 'string' || status.error_code !== 500) {
      const made = [...ctx.temps].filter(([key]) => !before.has(key));
      db.prepare('INSERT OR REPLACE INTO processed_commands (user_id, uuid, status, created_at) VALUES (?, ?, ?, ?)')
        .run(viewer.id, uuid, JSON.stringify({ status, temps: made }), ctx.now);
    }
  }
  return { sync_status, temp_id_mapping: Object.fromEntries(ctx.temps) };
}

export const MAX_COMMANDS = 500;

export function parseCommands(raw: unknown): CommandInput[] {
  if (raw === undefined || raw === null || raw === '') return [];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw ApiFailure.badRequest('The commands are not valid JSON.', 'INVALID_ARGUMENT');
    }
  }
  if (!Array.isArray(value)) throw ApiFailure.badRequest('The commands must be a list.', 'INVALID_ARGUMENT');
  if (value.length > MAX_COMMANDS) throw ApiFailure.badRequest(`A request carries at most ${MAX_COMMANDS} commands.`, 'TOO_MANY_COMMANDS');
  return value as CommandInput[];
}

/**
 * `*` asks for everything. A token is `<account id>:<sequence>` and asks for
 * what changed after that sequence, but only for the account it was issued to:
 * a token from another account (or an old plain number) gets everything, so one
 * account's cache is never completed with another account's changes.
 */
export function parseToken(raw: unknown, viewerId: string): number | null {
  if (raw === undefined || raw === null || raw === '' || raw === '*') return null;
  if (typeof raw !== 'string' || !/^[0-9a-f]{1,64}:\d{1,15}$|^\d{1,15}$/.test(raw)) {
    throw new ApiFailure(400, 'The sync token is not one this server issued.', 'INVALID_SYNC_TOKEN');
  }
  const match = /^([0-9a-f]{1,64}):(\d{1,15})$/.exec(raw);
  if (!match || match[1] !== viewerId) return null;
  return Number(match[2]);
}

export function parseTypes(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw ApiFailure.badRequest('The resource types are not a list.', 'INVALID_ARGUMENT');
    }
  }
  if (!Array.isArray(value)) throw ApiFailure.badRequest('The resource types are not a list.', 'INVALID_ARGUMENT');
  return value.filter((type): type is string => typeof type === 'string' && (RESOURCE_TYPES as readonly string[]).includes(type));
}

/**
 * One sync request: the commands it carries, then everything that changed since
 * the token it came with (the person's own changes included).
 */
export function syncRequest(db: Db, viewer: UserRow, body: { sync_token?: unknown; resource_types?: unknown; commands?: unknown; account_id?: unknown }) {
  const token = parseToken(body.sync_token, viewer.id);
  const types = parseTypes(body.resource_types);
  const commands = parseCommands(body.commands);
  // Writes say which account they were made for. A window that changed account must not send them as the new one.
  if (commands.length && typeof body.account_id === 'string' && body.account_id !== viewer.id) {
    throw new ApiFailure(409, 'This window is signed in to another account. Nothing was changed.', 'ACCOUNT_CHANGED');
  }
  return db.transaction(() => {
    const outcome = commands.length ? runCommands(db, viewer, commands) : { sync_status: {}, temp_id_mapping: {} };
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id) as UserRow;
    // A token from the future (a database that was replaced) cannot be trusted: everything is sent again.
    const since = token !== null && token <= currentSeq(db) ? token : null;
    const read = readFor(db, fresh, since, types);
    return {
      ...read.data,
      full_sync: read.full_sync,
      sync_token: read.sync_token,
      sync_status: outcome.sync_status,
      temp_id_mapping: outcome.temp_id_mapping,
    };
  })();
}
