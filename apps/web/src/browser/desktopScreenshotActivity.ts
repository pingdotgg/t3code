import { DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY } from "@t3tools/contracts";
import { flushSync } from "react-dom";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

export function installDesktopScreenshotActivity(isHostedTab: (tabId: string) => boolean) {
  const leases = new Map<string, { readonly tabId: string; readonly release: () => void }>();
  const activity = (tabId: unknown, token: unknown, active: unknown): boolean => {
    if (typeof tabId !== "string" || typeof token !== "string" || typeof active !== "boolean") {
      return false;
    }
    const current = leases.get(token);
    if (current && current.tabId !== tabId) return false;
    if (!active) {
      current?.release();
      leases.delete(token);
      return true;
    }
    if (current) return true;
    if (!isHostedTab(tabId)) return false;
    // The native caller needs the guest's new position committed before asking
    // Chromium for a frame, including when the owning chat is not mounted.
    flushSync(() => {
      leases.set(token, { tabId, release: acquireBrowserSurfaceActivity(tabId) });
    });
    return true;
  };
  Object.defineProperty(globalThis, DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY, {
    configurable: true,
    value: activity,
  });
  return () => {
    for (const lease of leases.values()) lease.release();
    leases.clear();
    if (Reflect.get(globalThis, DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY) === activity) {
      Reflect.deleteProperty(globalThis, DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY);
    }
  };
}
