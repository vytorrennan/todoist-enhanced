/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface Window {
  /** Present only inside the desktop app (desktop/), which adds it in its preload script. */
  enhancedDesktop?: {
    hideQuickAdd: () => void;
    /** Added in version 1.1 of the app: an older app has neither. */
    getQuickAddShortcut?: () => Promise<string>;
    setQuickAddShortcut?: (accelerator: string) => Promise<{ ok: boolean; shortcut: string }>;
    /** Added in version 1.1.1 of the app: an older app does not say its version. */
    getVersion?: () => Promise<string | null>;
    testMode?: boolean;
  };
}
