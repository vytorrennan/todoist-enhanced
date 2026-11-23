/* eslint-disable @typescript-eslint/no-explicit-any -- tool and API replies are untyped JSON; each test asserts the fields it reads. */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** The server as it is deployed: the bundle `npm run build:server` writes at the repository root. */
export const SERVER_BUNDLE = resolve(import.meta.dirname, '../../dist-server/index.mjs');

/** The official Todoist MCP server, pinned in this folder's package.json, run as the stdio server people start. */
export const MCP_ENTRY = resolve(import.meta.dirname, '../node_modules/@todoist/mcp/dist/main.js');

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A folder that is removed when the suite ends. */
export function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `tde-${label}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

export interface RunningServer {
  base: string;
  dataDir: string;
  /** What the process printed, for a failing test to show. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * The server, as its own process, on a free port, with its data in `dataDir`. Starts only when it answers its health
 * check, and stops with SIGTERM, as a service manager would stop it.
 */
export async function startServer(dataDir: string): Promise<RunningServer> {
  if (!existsSync(SERVER_BUNDLE)) throw new Error(`The server bundle is missing at ${SERVER_BUNDLE}. Run npm run build:server first.`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let printed = '';
  const child = spawn(process.execPath, [SERVER_BUNDLE], {
    cwd: dataDir,
    env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, STATIC_DIR: join(dataDir, 'no-app'), TDE_SIGNUP: 'open' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => { printed += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { printed += chunk.toString(); });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The server stopped while starting:\n${printed}`);
    try {
      if ((await fetch(`${base}/api/v1/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`The server did not answer its health check:\n${printed}`);
    }
    await sleep(100);
  }

  return {
    base,
    dataDir,
    output: () => printed,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    },
  };
}

export interface Account {
  id: string;
  email: string;
  token: string;
  inboxId: string;
}

/** A new account on the server, signed in. Each call makes a new address. */
export async function register(base: string, fullName: string): Promise<Account> {
  const email = `e2e-${randomBytes(6).toString('hex')}@example.com`;
  const reply = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-long-password', full_name: fullName, timezone: 'UTC' }),
  });
  if (reply.status !== 201) throw new Error(`Registering an account failed: ${reply.status} ${await reply.text()}`);
  const body = (await reply.json()) as { token: string; user: { id: string; inbox_project_id: string } };
  return { id: body.user.id, email, token: body.token, inboxId: body.user.inbox_project_id };
}

/** One request to the app's Sync API, as the app sends it: the commands in a JSON form field. */
export async function sync(base: string, token: string, commands: unknown[]): Promise<{ status: number; body: any }> {
  const form = new URLSearchParams({ commands: JSON.stringify(commands) });
  const reply = await fetch(`${base}/api/v1/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await reply.text();
  return { status: reply.status, body: text ? JSON.parse(text) : undefined };
}

/** A command for the Sync API, with its own uuid and, for creations, a temp id the reply maps to a real one. */
export function command(type: string, args: Record<string, unknown>, tempId?: string) {
  return { type, uuid: randomUUID(), args, ...(tempId ? { temp_id: tempId } : {}) };
}

/** Creates an object through the Sync API and returns its real id. */
export async function createThrough(base: string, token: string, type: string, args: Record<string, unknown>): Promise<string> {
  const temp = randomUUID();
  const reply = await sync(base, token, [command(type, args, temp)]);
  const id = reply.body?.temp_id_mapping?.[temp];
  if (typeof id !== 'string') throw new Error(`${type} did not create an object: ${JSON.stringify(reply.body)}`);
  return id;
}

export interface Assistant {
  client: Client;
  /** What the MCP server printed to its standard error. */
  stderr(): string;
  close(): Promise<void>;
}

/**
 * The official MCP server, started the way an assistant starts it: as a stdio child process with its token and the
 * base URL of the server under test. Nothing else from this machine's environment reaches it.
 */
export async function connectAssistant(base: string, token: string): Promise<Assistant> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    cwd: tmpdir(),
    env: { ...getDefaultEnvironment(), TODOIST_API_KEY: token, TODOIST_BASE_URL: base },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'todoist-enhanced-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

export interface Reply<T = any> {
  /** The tool reported a failure: a refused input, or an error from the API. */
  isError: boolean;
  /** The text the assistant reads. */
  text: string;
  /** The structured result, when the tool gives one. */
  data: T;
}

/** Calls one tool. A failure is returned as a reply, not thrown, so a test can check what the assistant is told. */
export async function call<T = any>(assistant: Assistant, name: string, args: Record<string, unknown> = {}): Promise<Reply<T>> {
  const result = await assistant.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => (part.type === 'text' ? part.text ?? '' : ''))
    .join('\n');
  return { isError: result.isError === true, text, data: result.structuredContent as T };
}
