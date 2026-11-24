import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from './app';

/**
 * The server, started from the command line.
 *
 * Everything is set by environment variables, with defaults that suit one
 * person running it on their own machine:
 *
 *   PORT                 8787
 *   HOST                 127.0.0.1 (set 0.0.0.0 to answer other machines)
 *   DATA_DIR             ./data     the database (enhanced.db) and uploads
 *   STATIC_DIR           ./dist     the built app, served when it exists
 *   TDE_SIGNUP           open       "closed" stops new accounts
 *   TDE_SECURE_COOKIES   0          "1" marks the session cookie Secure (HTTPS only)
 *   TDE_MAX_UPLOAD_MB    25
 *   TDE_REQUESTS_PER_MINUTE  600    per person, before a 429 with Retry-After
 */
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const staticDir = resolve(process.env.STATIC_DIR ?? 'dist');
const signup = (process.env.TDE_SIGNUP ?? 'open').toLowerCase() !== 'closed';
const secureCookies = process.env.TDE_SECURE_COOKIES === '1';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

mkdirSync(dataDir, { recursive: true });
const app = createApp({
  database: join(dataDir, 'enhanced.db'),
  dataDir,
  staticDir: existsSync(staticDir) ? staticDir : undefined,
  signup,
  secureCookies,
  version: pkg.version,
});

app.server.listen(port, host, () => {
  console.log(`Enhanced for Todoist server ${pkg.version} on http://${host}:${port}`);
  console.log(`  data: ${dataDir}`);
  console.log(`  app:  ${existsSync(staticDir) ? staticDir : 'not built (run npm run build)'}`);
  console.log(`  new accounts: ${signup ? 'open' : 'closed'}`);
});

const stop = () => {
  app.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
