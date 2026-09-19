import { captureBrowserScreenshot } from "~/browser/browserScreenshot";

/**
 * Module-level handle to the desktop preview bridge.
 *
 * Resolved once at import time so React hooks don't pay for repeated
 * `window.desktopBridge?.preview` lookups on every render. `null` on the web
 * build where there's no Electron host.
 */
const desktopPreview =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);

export const previewBridge = desktopPreview
  ? {
      ...desktopPreview,
      captureScreenshot: (tabId: string) =>
        captureBrowserScreenshot(tabId, () => desktopPreview.captureScreenshot(tabId)),
      automation: {
        ...desktopPreview.automation,
        snapshot: (tabId: string) =>
          captureBrowserScreenshot(tabId, () => desktopPreview.automation.snapshot(tabId)),
      },
    }
  : null;
