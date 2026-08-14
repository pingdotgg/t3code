import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

export type ResponsiveSidebarState = "expanded" | "collapsed";

export const SIDEBAR_OPEN_STORAGE_KEY = "t3code:sidebar-open";

export function resolveSidebarState(input: {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
}): ResponsiveSidebarState {
  return (input.isMobile ? input.openMobile : input.open) ? "expanded" : "collapsed";
}

export function readPersistedSidebarOpen(fallback = true): boolean {
  try {
    return getLocalStorageItem(SIDEBAR_OPEN_STORAGE_KEY, Schema.Boolean) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePersistedSidebarOpen(open: boolean): void {
  try {
    setLocalStorageItem(SIDEBAR_OPEN_STORAGE_KEY, open, Schema.Boolean);
  } catch {
    // Preference persistence is best-effort.
  }
}
