import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/**
 * The security headers the app is served with.
 *
 * The server (server/app.ts) sends the same policy for the built app, and
 * `npm run preview` sends it here, so a build is checked against the policy it
 * will run under. Keep them in step.
 */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    "frame-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * The server the app talks to in development and preview: the backend on this
 * machine, which `npm run server` starts. Set VITE_API_PROXY to point elsewhere.
 */
const API_PROXY = {
  '/api': {
    target: process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8787',
    changeOrigin: false,
  },
};

/**
 * Hugeicons draws its paths with five decimals. On a 24px grid two are far
 * below what an eye can tell, and they shorten the icons we ship by about a
 * quarter once compressed.
 */
function roundHugeiconsPaths(): Plugin {
  return {
    name: 'round-hugeicons-paths',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@hugeicons[\\/]core-free-icons[\\/]dist[\\/]esm[\\/][^\\/]+\.js$/.test(id)) return null;
      return code.replace(/\bd: "([^"]+)"/g, (_all, path: string) => `d: "${path.replace(/-?\d+\.\d{3,}/g, (n) => String(Number(Number(n).toFixed(2))))}"`);
    },
  };
}

export default defineConfig({
  // Relative base so the build can be dropped into any subfolder.
  base: './',
  preview: { headers: SECURITY_HEADERS, proxy: API_PROXY },
  // Trace HTML files are test artefacts, never application pages to reload.
  server: { proxy: API_PROXY, watch: { ignored: ['**/test-results*/**', '**/playwright-report/**'] } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    roundHugeiconsPaths(),
    VitePWA({
      /* The app decides when a new build takes over (src/lib/appUpdate.ts):
         only after the person chooses Reload. */
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      /* The service worker is a build artefact only. The plugin can serve a
         development one, but under this app's relative `base` it fails to
         register and fills the console with an error about a script it cannot
         fetch — which is noise standing in for the very thing it was turned on
         to check. Installing is verified against a build. */
      manifest: {
        /* A stable identity for the installed app, independent of the URL it
           was installed from. Chromium browsers — Brave included — will not
           offer to install a manifest they cannot tell apart from another. */
        id: './',
        name: 'Enhanced for Todoist',
        short_name: 'Enhanced',
        description: 'Plan your week. A local-first client for your own tasks, kept on your own server.',
        theme_color: '#d1453b',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          /* A maskable icon is cropped to whatever shape the system likes, so
             it needs its own full-bleed square. The rounded one was losing its
             corners to the mask. */
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The share card is fetched by link scrapers, never by the app. There
        // is no reason to spend a fifth of the offline cache on it.
        globIgnores: ['og-image.png'],
        // The new worker waits for the page's go-ahead (SKIP_WAITING from
        // registerSW), then claims every tab, so no tab runs on two builds.
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // The API is never cached: the app owns its own offline cache in IndexedDB.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
    }),
  ],
});
