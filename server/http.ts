import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ApiFailure } from './db';
import type { UserRow } from './auth';

/** A tiny router and the response helpers the API uses. No framework: the surface is small and worth reading. */

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  raw: IncomingMessage;
  ip: string;
  body: unknown;
  /** The signed-in person, on routes that need one. */
  user: UserRow | null;
  /** The bearer token, or the session cookie for routes that allow it. */
  bearer: string | null;
  cookie: string | null;
}

export type Handler = (req: Request, res: Response) => Promise<void> | void;

export interface Response {
  status(code: number): Response;
  json(value: unknown): void;
  empty(): void;
  header(name: string, value: string): void;
  raw: ServerResponse;
}

const MAX_BODY = 8 * 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "connect-src 'self'",
    "img-src 'self' data: blob:", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'",
    "base-uri 'self'", "frame-src 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export function response(raw: ServerResponse): Response {
  let code = 200;
  return {
    raw,
    status(next) { code = next; return this; },
    json(value) {
      const body = JSON.stringify(value);
      raw.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      raw.end(body);
    },
    empty() { raw.writeHead(code === 200 ? 204 : code, { 'Cache-Control': 'no-store' }); raw.end(); },
    header(name, value) { raw.setHeader(name, value); },
  };
}

export function sendFailure(res: Response, error: unknown): void {
  if (error instanceof ApiFailure) {
    res.status(error.status).json({ error: error.message, error_tag: error.tag, error_code: error.code });
    return;
  }
  console.error('Request failed:', error);
  res.status(500).json({ error: 'The server could not do that.', error_tag: 'INTERNAL', error_code: 500 });
}

/** The body of a request, read by its content type. */
export function readBody(raw: IncomingMessage, contentType: string): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    raw.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ApiFailure(413, 'The request is too large.', 'REQUEST_TOO_LARGE'));
        raw.destroy();
        return;
      }
      chunks.push(chunk);
    });
    raw.on('error', reject);
    raw.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolveBody({}); return; }
      if (contentType.includes('application/json')) {
        try {
          resolveBody(JSON.parse(text));
        } catch {
          reject(ApiFailure.badRequest('The request is not valid JSON.', 'INVALID_ARGUMENT'));
        }
        return;
      }
      if (contentType.includes('application/x-www-form-urlencoded')) {
        resolveBody(Object.fromEntries(new URLSearchParams(text)));
        return;
      }
      resolveBody({});
    });
  });
}

interface Route { method: string; parts: string[]; handler: Handler; auth: 'bearer' | 'cookie-or-bearer' | 'none' }

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, auth: Route['auth'], handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, auth });
  }

  /** Finds the route for a request: the handler, its params, and whether the path exists under another method. */
  match(method: string, path: string): { route: Route; params: Record<string, string> } | { methodNotAllowed: true } | null {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const want = route.parts[i];
        if (want.startsWith(':')) {
          try {
            params[want.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
            break;
          }
        } else if (want !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/** Per-client request budget: a burst is fine, a loop is slowed down with a clear Retry-After. */
const BUDGET = Number(process.env.TDE_REQUESTS_PER_MINUTE ?? 600);
const buckets = new Map<string, { tokens: number; at: number }>();

export function spend(key: string, now = Date.now()): number {
  const bucket = buckets.get(key) ?? { tokens: BUDGET, at: now };
  const refilled = Math.min(BUDGET, bucket.tokens + ((now - bucket.at) / 60_000) * BUDGET);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, at: now });
    return Math.ceil((1 - refilled) * (60_000 / BUDGET) / 1000);
  }
  buckets.set(key, { tokens: refilled - 1, at: now });
  return 0;
}

export function resetBudgets(): void {
  buckets.clear();
}

/** Serves the built app: real files as they are, anything else as the app's page. */
export function serveStatic(root: string, urlPath: string, res: Response, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const base = resolve(root);
  const requested = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, '');
  let file = resolve(base, requested);
  if (file !== base && !file.startsWith(base + sep)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(requested)) return false;
    file = join(base, 'index.html');
    if (!existsSync(file)) return false;
  }
  const name = file.slice(base.length + 1).split(sep).join('/');
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(statSync(file).size) };
  if (/^assets\//.test(name)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  else headers['Cache-Control'] = 'no-cache, must-revalidate';
  res.raw.writeHead(200, headers);
  if (method === 'HEAD') { res.raw.end(); return true; }
  createReadStream(file).pipe(res.raw);
  return true;
}

export function securityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.header(name, value);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
