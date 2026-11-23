import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end journeys against the real server: the app is built, the server
 * starts on a brand-new database, and every person in these tests creates
 * their own account through the screens, as a person would.
 *
 * The demo journeys in `e2e/` keep using the demo account; these do not.
 */
const PORT = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? 4187);
const dataDir = mkdtempSync(join(tmpdir(), 'tde-e2e-'));

export default defineConfig({
  testDir: 'e2e-server',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build && npm run build:server && node dist-server/index.mjs',
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      STATIC_DIR: 'dist',
      TDE_REQUESTS_PER_MINUTE: '100000',
    },
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
