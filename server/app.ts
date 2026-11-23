import { createServer, type IncomingMessage, type Server } from 'node:http';
import Busboy from 'busboy';
import { statSync, createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiFailure, type Db, openDatabase } from './db';
import {
  checkLogin, clearLoginAttempts, createSession, hashPassword, loginWait, normalizeEmail, recordLoginAttempt,
  registerUser, revokeOtherSessions, revokeSession, userForToken, validatePassword, verifyPassword, type UserRow, SESSION_DAYS,
} from './auth';
import { Router, readBody, response, sendFailure, serveStatic, spend, securityHeaders, type Request, type Response } from './http';
import { userOut, projectOut } from './serialize';
import { syncRequest } from './commands';
import { projectPeople } from './projects';
import { workspaceUsers, setWorkspaceRole } from './workspaces';
import { completedTasks } from './history';
import { importAnswer, registerRest } from './rest';

import { setReaction } from './notes';
import { fileFor, filesDir, removeUpload, storeUpload, MAX_UPLOAD_BYTES, type StoredFile } from './files';
import { updateUser } from './account';
import { makeCtx, type Ctx } from './ctx';
import { currentSeq } from './db';

export interface AppOptions {
  /** Path of the SQLite file, or `:memory:` for tests. */
  database: string;
  /** Where uploads are kept. */
  dataDir: string;
  /** The built app to serve, if any. */
  staticDir?: string;
  /** Whether anyone may create an account. */
  signup?: boolean;
  /** Mark the session cookie Secure (on for HTTPS deployments). */
  secureCookies?: boolean;
  version?: string;
  /** The largest upload accepted, in bytes. */
  maxUploadBytes?: number;
}

export interface App {
  server: Server;
  db: Db;
  close(): Promise<void>;
}

const SESSION_COOKIE = 'tde_session';

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const bearerOf = (header: string | undefined): string | null => {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? match[1].trim() : null;
};

function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/v1/files; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 3600}${secure ? '; Secure' : ''}`;
}

const clearCookie = (secure: boolean): string => `${SESSION_COOKIE}=; Path=/api/v1/files; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

function pageArgs(req: Request) {
  return { cursor: req.query.get('cursor') ?? undefined, limit: Number(req.query.get('limit') ?? 100) || 100 };
}

/** Builds the HTTP server, with its database open. Nothing listens until `listen` is called on it. */
export function createApp(options: AppOptions): App {
  const db = openDatabase(options.database);
  const signupOpen = options.signup ?? true;
  const version = options.version ?? '0.0.0';
  const uploadLimit = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const router = new Router();

  const secureFor = (raw: IncomingMessage) => options.secureCookies === true
    || Boolean((raw.socket as { encrypted?: boolean }).encrypted)
    || String(raw.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

  /** Signs a person in: a session, its cookie, and the answer the app keeps. */
  const signedIn = (user: UserRow, req: Request, res: Response) => {
    const session = createSession(db, user.id);
    res.header('Set-Cookie', sessionCookie(session.token, secureFor(req.raw)));
    return { token: session.token, expires_at: session.expiresAt, user: userOut(user) };
  };

  router.add('GET', '/api/v1/health', 'none', (_req, res) => res.json({ ok: true, version, seq: currentSeq(db) }));

  router.add('GET', '/api/v1/auth/config', 'none', (_req, res) => res.json({ signup: signupOpen, version }));

  router.add('POST', '/api/v1/auth/register', 'none', async (req, res) => {
    if (!signupOpen) throw new ApiFailure(403, 'New accounts are not open on this server.', 'SIGNUP_CLOSED');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const user = await registerUser(db, {
      email: body.email, password: body.password, full_name: body.full_name, timezone: body.timezone, lang: body.lang,
    });
    res.status(201).json(signedIn(user, req, res));
  });

  router.add('POST', '/api/v1/auth/login', 'none', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${req.ip}|${email}`;
    const wait = loginWait(key);
    if (wait > 0) {
      res.header('Retry-After', String(wait));
      throw new ApiFailure(429, 'Too many attempts. Wait a few minutes and try again.', 'TOO_MANY_ATTEMPTS', 429);
    }
    // Counted before the check, which takes time: attempts made meanwhile must count too.
    recordLoginAttempt(key);
    const user = await checkLogin(db, email, password);
    if (!user) throw new ApiFailure(401, 'That email and password do not match an account.', 'INVALID_CREDENTIALS');
    clearLoginAttempts(key);
    res.status(200).json(signedIn(user, req, res));
  });

  router.add('POST', '/api/v1/auth/logout', 'cookie-or-bearer', (req, res) => {
    const token = req.bearer ?? req.cookie;
    if (token) revokeSession(db, token);
    // Only the cookie of the session that was just revoked is cleared: a late sign-out must not clear a newer sign-in.
    if (token && req.cookie === token) res.header('Set-Cookie', clearCookie(secureFor(req.raw)));
    res.empty();
  });

  router.add('GET', '/api/v1/auth/me', 'bearer', (req, res) => res.json({ user: userOut(req.user as UserRow) }));

  router.add('POST', '/api/v1/auth/me', 'bearer', (req, res) => {
    const user = req.user as UserRow;
    updateUser(ctxFor(req), (req.body ?? {}) as Record<string, unknown>);
    res.json({ user: userOut(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow) });
  });

  router.add('POST', '/api/v1/auth/password', 'bearer', async (req, res) => {
    const user = req.user as UserRow;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = typeof body.current_password === 'string' ? body.current_password : '';
    const verified = user.password_hash;
    if (!(await verifyPassword(current, verified))) {
      throw new ApiFailure(403, 'The current password is not right.', 'WRONG_PASSWORD');
    }
    const password = validatePassword(body.new_password);
    const hash = await hashPassword(password);
    // The awaits above let this session end or the password change. The write happens only if neither did.
    if (!userForToken(db, req.bearer)) throw ApiFailure.unauthorized();
    const changed = db.prepare('UPDATE users SET password_hash = ?, seq = seq WHERE id = ? AND password_hash = ?')
      .run(hash, user.id, verified).changes;
    if (changed !== 1) throw new ApiFailure(403, 'The current password is not right.', 'WRONG_PASSWORD');
    revokeOtherSessions(db, user.id, req.bearer ?? '');
    res.empty();
  });

  router.add('POST', '/api/v1/sync', 'bearer', (req, res) => {
    const user = req.user as UserRow;
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(syncRequest(db, user, body as Parameters<typeof syncRequest>[2]));
  });


  router.add('GET', '/api/v1/projects/:id/full', 'bearer', (req, res) => {
    const user = req.user as UserRow;
    const id = req.params.id;
    const project = db.prepare(`SELECT p.*, m.role, m.is_favorite, m.collapsed, m.child_order, m.order_key,
        (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id AND x.state = 'active') AS shared_count
      FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? AND m.state = 'active'
      WHERE p.id = ? AND p.is_deleted = 0`).get(user.id, id) as Parameters<typeof projectOut>[0] | undefined;
    if (!project) throw ApiFailure.notFound('That project does not exist.', 'PROJECT_NOT_FOUND');
    const people = projectPeople(db, user.id, id);
    res.json({ project: projectOut(project), collaborators: people.people, collaborator_states: people.states });
  });

  router.add('GET', '/api/v1/workspaces/users', 'bearer', (req, res) => {
    const page = pageArgs(req);
    res.json(workspaceUsers(db, (req.user as UserRow).id, req.query.get('workspace_id') ?? '', page.cursor));
  });

  router.add('POST', '/api/v1/workspaces/:id/users/:userId', 'bearer', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    setWorkspaceRole(ctxFor(req), req.params.id, req.params.userId, body.role);
    res.json({});
  });




  router.add('GET', '/api/v1/tasks/completed', 'bearer', (req, res) => {
    res.json(completedTasks(db, (req.user as UserRow).id, queryOf(req)));
  });

  // The REST API v1 (what the official SDK and MCP call): see rest.ts. Registered after the specific task routes it must not shadow.
  registerRest(router, db);




  router.add('POST', '/api/v1/comments/:id/reactions', 'bearer', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(setReaction(ctxFor(req), req.params.id, body.reaction, true));
  });

  router.add('POST', '/api/v1/comments/:id/reactions/remove', 'bearer', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    setReaction(ctxFor(req), req.params.id, body.reaction, false);
    res.empty();
  });

  router.add('POST', '/api/v1/uploads', 'bearer', async (req, res) => {
    if (!String(req.raw.headers['content-type'] ?? '').includes('multipart/form-data')) {
      throw ApiFailure.badRequest('Send the file as a multipart form.', 'INVALID_ARGUMENT');
    }
    const file = await receiveUpload(req.raw, req.user as UserRow, () => userForToken(db, req.bearer) !== null);
    res.status(201).json(file);
  });

  // A CSV file imported into a project (the API's import, as the MCP calls it).
  router.add('POST', '/api/v1/projects/:id/import', 'bearer', async (req, res) => {
    if (!String(req.raw.headers['content-type'] ?? '').includes('multipart/form-data')) {
      throw ApiFailure.badRequest('Send the file as a multipart form.', 'INVALID_ARGUMENT');
    }
    const owner = req.user as UserRow;
    const file = await receiveUpload(req.raw, owner, () => userForToken(db, req.bearer) !== null);
    try {
      const text = readFileSync(join(filesDir(options.dataDir), file.id), 'utf8');
      res.json(importAnswer(db, owner, req.params.id, text));
    } finally {
      removeUpload(db, options.dataDir, file.id);
    }
  });

  router.add('GET', '/api/v1/files/:id', 'cookie-or-bearer', (req, res) => {
    const user = req.user as UserRow;
    const file = fileFor(db, options.dataDir, user.id, req.params.id);
    res.header('Content-Type', file.type);
    res.header('Content-Length', String(statSync(file.path).size));
    res.header('Cache-Control', 'private, no-cache');
    const disposition = file.type.startsWith('image/') ? 'inline' : 'attachment';
    res.header('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.name)}"`);
    res.raw.writeHead(200);
    createReadStream(file.path).pipe(res.raw);
  });

  const ctxFor = (req: Request): Ctx => makeCtx(db, req.user as UserRow);

  function queryOf(req: Request) {
    return Object.fromEntries(req.query.entries()) as Parameters<typeof completedTasks>[2];
  }

  async function receiveUpload(raw: IncomingMessage, owner: UserRow, stillSignedIn: () => boolean): Promise<StoredFile> {
    return new Promise<StoredFile>((resolveUpload, reject) => {
      let busboy: ReturnType<typeof Busboy>;
      try {
        busboy = Busboy({ headers: raw.headers, limits: { fileSize: uploadLimit, files: 1, fields: 5 } });
      } catch {
        reject(ApiFailure.badRequest('Send the file as a multipart form with a boundary.', 'INVALID_ARGUMENT'));
        return;
      }
      let name = '';
      let pending: Promise<StoredFile> | null = null;
      let source: { destroy: (error?: Error) => void } | null = null;
      let truncated = false;
      busboy.on('field', (field, value) => { if (field === 'file_name') name = value; });
      busboy.on('file', (field, stream, info) => {
        if (field !== 'file') { stream.resume(); return; }
        source = stream;
        stream.on('limit', () => { truncated = true; });
        pending = storeUpload(db, options.dataDir, owner, {
          name: name || info.filename || 'file',
          type: info.mimeType,
          body: stream,
          maxBytes: uploadLimit,
          // Judged before the row is kept: a truncated file, or one whose session ended while it arrived, is not kept.
          check: () => {
            if (truncated) throw new ApiFailure(413, 'That file is too large for this server.', 'FILE_TOO_LARGE');
            if (!stillSignedIn()) throw ApiFailure.unauthorized();
          },
        });
        pending.catch(() => undefined);
      });
      busboy.on('error', (failure: Error) => {
        const error = failure instanceof ApiFailure ? failure : ApiFailure.badRequest('The upload could not be read.', 'UPLOAD_FAILED');
        // A broken body leaves nothing behind: the file in progress is stopped, and one already kept is forgotten.
        source?.destroy(error);
        if (pending) pending.then((stored) => removeUpload(db, options.dataDir, stored.id), () => undefined);
        reject(error);
      });
      busboy.on('close', () => {
        if (!pending) { reject(ApiFailure.badRequest('Send the file in a field called “file”.', 'UPLOAD_MISSING')); return; }
        (pending as Promise<StoredFile>).then(resolveUpload, reject);
      });
      // A request that ends before its body does (the connection dropped) takes the upload with it.
      raw.on('close', () => { if (!raw.complete) busboy.destroy(new Error('The upload was interrupted.')); });
      raw.pipe(busboy);
    });
  }

  const server = createServer(async (raw, rawRes) => {
    const res = response(rawRes);
    securityHeaders(res);
    try {
      let url: URL;
      try {
        url = new URL(raw.url ?? '/', 'http://local');
      } catch {
        throw ApiFailure.badRequest('That address is not valid.', 'INVALID_ARGUMENT');
      }
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (options.staticDir && serveStatic(options.staticDir, path, res, raw.method ?? 'GET')) return;
        res.status(404).json({ error: 'Not found.', error_tag: 'NOT_FOUND', error_code: 404 });
        return;
      }
      const match = router.match(raw.method ?? 'GET', path);
      if (!match) { res.status(404).json({ error: 'That address does not exist.', error_tag: 'NOT_FOUND', error_code: 404 }); return; }
      if ('methodNotAllowed' in match) { res.status(405).json({ error: 'That method is not allowed here.', error_tag: 'METHOD_NOT_ALLOWED', error_code: 405 }); return; }

      const { route, params } = match;
      const bearer = bearerOf(raw.headers.authorization);
      const cookie = cookieValue(raw.headers.cookie, SESSION_COOKIE);
      const ip = String(raw.socket.remoteAddress ?? 'unknown');
      const request: Request = {
        method: raw.method ?? 'GET',
        path,
        query: url.searchParams,
        params,
        headers: raw.headers,
        raw,
        ip,
        body: undefined,
        bearer,
        cookie,
        user: null,
      };
      if (route.auth !== 'none') {
        const user = userForToken(db, route.auth === 'cookie-or-bearer' ? bearer ?? cookie : bearer);
        if (!user) throw ApiFailure.unauthorized();
        request.user = user;
        // A write names the account the window was showing. A window that has moved on to another account must not write as this one.
        const named = raw.headers['x-account-id'];
        if (request.method !== 'GET' && typeof named === 'string' && named !== user.id) {
          throw new ApiFailure(409, 'This window is signed in to another account. Nothing was changed.', 'ACCOUNT_CHANGED');
        }
        const wait = spend(user.id);
        if (wait > 0) {
          res.header('Retry-After', String(wait));
          throw new ApiFailure(429, 'Too many requests. Wait a moment.', 'RATE_LIMITED', 429);
        }
      } else {
        const wait = spend(`anon|${ip}`);
        if (wait > 0) {
          res.header('Retry-After', String(wait));
          throw new ApiFailure(429, 'Too many requests. Wait a moment.', 'RATE_LIMITED', 429);
        }
      }
      const contentType = String(raw.headers['content-type'] ?? '');
      if (raw.method === 'POST' && !contentType.includes('multipart/form-data')) {
        request.body = await readBody(raw, contentType);
      }
      // The session is checked again once the body has arrived: it may have ended while it was read.
      if (request.user && !userForToken(db, route.auth === 'cookie-or-bearer' ? bearer ?? cookie : bearer)) throw ApiFailure.unauthorized();
      await route.handler(request, res);
    } catch (error) {
      sendFailure(res, error);
    }
  });

  return {
    server,
    db,
    close: () => new Promise<void>((resolveClose) => {
      server.close(() => {
        db.close();
        resolveClose();
      });
    }),
  };
}

