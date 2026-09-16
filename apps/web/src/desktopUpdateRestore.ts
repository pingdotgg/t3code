import type { DesktopBridge, DesktopUpdateActionResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getDesktopUpdateActionError } from "./components/desktopUpdate.logic";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";

export const DESKTOP_UPDATE_RESTORE_STORAGE_KEY = "t3code:desktop-update-restore:v1";

// Installing a downloaded update relaunches within seconds. A hint older than
// this belongs to an install that never came back and must not steer a later
// cold launch away from the usual fresh draft.
export const DESKTOP_UPDATE_RESTORE_MAX_AGE_MS = 10 * 60 * 1000;

const DesktopUpdateRestoreSchema = Schema.Struct({
  location: Schema.String,
  savedAt: Schema.Number,
});

type DesktopUpdateRestore = typeof DesktopUpdateRestoreSchema.Type;

/**
 * Picks the route to reopen after an update relaunch, or null when the saved
 * hint is missing, stale, or not a route path.
 */
export function resolveDesktopUpdateRestoreLocation(
  saved: DesktopUpdateRestore | null,
  now: number,
): string | null {
  if (saved === null) return null;
  if (now - saved.savedAt > DESKTOP_UPDATE_RESTORE_MAX_AGE_MS || now < saved.savedAt) return null;
  if (!saved.location.startsWith("/") || saved.location.startsWith("//")) return null;
  if (saved.location === "/") return null;
  return saved.location;
}

export function saveDesktopUpdateRestoreLocation(location: string, now = Date.now()): void {
  try {
    setLocalStorageItem(
      DESKTOP_UPDATE_RESTORE_STORAGE_KEY,
      { location, savedAt: now },
      DesktopUpdateRestoreSchema,
    );
  } catch (error) {
    console.error("Could not persist the desktop update restore location.", error);
  }
}

function clearDesktopUpdateRestoreLocation(): void {
  try {
    removeLocalStorageItem(DESKTOP_UPDATE_RESTORE_STORAGE_KEY);
  } catch (error) {
    console.error("Could not clear the desktop update restore location.", error);
  }
}

/** Reads and clears the saved route so it applies to one launch only. */
export function takeDesktopUpdateRestoreLocation(now = Date.now()): string | null {
  let saved: DesktopUpdateRestore | null = null;
  try {
    saved = getLocalStorageItem(DESKTOP_UPDATE_RESTORE_STORAGE_KEY, DesktopUpdateRestoreSchema);
  } catch (error) {
    console.error("Could not read the desktop update restore location.", error);
  }
  clearDesktopUpdateRestoreLocation();
  return resolveDesktopUpdateRestoreLocation(saved, now);
}

/**
 * Installs the downloaded update and remembers the current route so the
 * relaunched app reopens it instead of landing on a fresh draft. Electron
 * uses hash history, so the hash carries the whole route.
 */
export function installDesktopUpdate(
  bridge: Pick<DesktopBridge, "installUpdate">,
): Promise<DesktopUpdateActionResult> {
  saveDesktopUpdateRestoreLocation(window.location.hash.slice(1));
  return bridge.installUpdate().then(
    (result) => {
      if (!result.accepted || getDesktopUpdateActionError(result) !== null) {
        clearDesktopUpdateRestoreLocation();
      }
      return result;
    },
    (error: unknown) => {
      clearDesktopUpdateRestoreLocation();
      throw error;
    },
  );
}

/**
 * Runs once at Electron startup, before the router reads the hash. A launch
 * that already carries a route keeps it.
 */
export function restoreDesktopUpdateLocation(): void {
  const location = takeDesktopUpdateRestoreLocation();
  if (location === null) return;
  const currentHash = window.location.hash;
  if (currentHash.length > 1 && currentHash !== "#/") return;
  window.history.replaceState(window.history.state, "", `#${location}`);
}
