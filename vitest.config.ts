import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * The unit tests: the rules in `src/domain`, the parts of `src/api` and
 * `src/store` that are plain functions, and the server in `server/`. Kept
 * apart from `vite.config.ts` so the app's plugins (the service worker) never
 * run under test. End-to-end journeys live in `e2e/` and run with Playwright.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
  },
});
