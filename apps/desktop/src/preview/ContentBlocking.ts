import {
  DEFAULT_CLIENT_SETTINGS,
  ENTERTAINMENT_BROWSER_PROFILE_ID,
  type EntertainmentBlockingSettings,
} from "@t3tools/contracts";
import { createContentBlocker } from "@t3tools/shared/contentBlocking";
import type { Session } from "electron";

/**
 * Ad and tracker blocking for the Entertainment browser profile only, so development browsing and
 * app previews are never filtered. The renderer's settings reconfigure it live.
 */
let blocker = createContentBlocker(DEFAULT_CLIENT_SETTINGS.entertainmentBlocking);

export function configureContentBlocking(settings: EntertainmentBlockingSettings) {
  blocker = createContentBlocker(settings);
}

/** True for a profile session scope (`[environmentId, profileId]`) of the Entertainment profile. */
export function isEntertainmentScope(scope: string): boolean {
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) && parsed[1] === ENTERTAINMENT_BROWSER_PROFILE_ID;
  } catch {
    return false;
  }
}

function topLevelUrl(details: Electron.OnBeforeRequestListenerDetails): string | null {
  try {
    return details.frame?.top?.url || null;
  } catch {
    // The frame can be gone by the time a late request is checked.
    return null;
  }
}

export function installContentBlocking(session: Session) {
  session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      // Navigations always load; only the requests a page makes are filtered.
      if (details.resourceType === "mainFrame") {
        callback({});
        return;
      }
      callback(blocker.shouldBlock(details.url, topLevelUrl(details)) ? { cancel: true } : {});
    },
  );
}
