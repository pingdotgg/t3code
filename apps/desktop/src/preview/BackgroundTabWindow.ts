import type { BrowserWindowConstructorOptions } from "electron";

// Kept free of runtime imports: scripts/verify-background-preview.mjs loads it
// straight into Electron to prove these options still paint while the app
// window is hidden.

// The server sizes the page through emulation; this only seeds the window.
const BACKGROUND_TAB_WIDTH = 1280;
const BACKGROUND_TAB_HEIGHT = 800;

/**
 * An agent tab's never-shown window. A panel `<webview>` that attaches while
 * the app window is hidden or minimized never paints, so its screenshots never
 * return; a window of its own paints in every app window state.
 */
export function backgroundTabWindowOptions(input: {
  readonly partition: string;
  readonly preload: string;
  readonly passkeyBridgeArgument: string | undefined;
}): BrowserWindowConstructorOptions {
  return {
    width: BACKGROUND_TAB_WIDTH,
    height: BACKGROUND_TAB_HEIGHT,
    show: false,
    paintWhenInitiallyHidden: true,
    skipTaskbar: true,
    webPreferences: {
      partition: input.partition,
      preload: input.preload,
      // Mirrors `will-attach-webview` for panel guests.
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: false,
      disableHtmlFullscreenWindowResize: true,
      backgroundThrottling: false,
      ...(input.passkeyBridgeArgument === undefined
        ? {}
        : { additionalArguments: [input.passkeyBridgeArgument] }),
    },
  };
}
