import type { ThreadId } from "@t3tools/contracts";

import { SETTINGS_ROUTE_PATH } from "./settingsToggle";

let pendingSettingsScrollRestoreThreadId: ThreadId | null = null;

export function resolveSettingsScrollRestoreThreadId(href: string): ThreadId | null {
  const routeHref = href.startsWith("#") ? href.slice(1) || "/" : href;

  let pathname: string;
  try {
    pathname = new URL(routeHref, "http://localhost").pathname;
  } catch {
    return null;
  }

  if (pathname === "/" || pathname === SETTINGS_ROUTE_PATH) {
    return null;
  }

  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (normalizedPath.length === 0 || normalizedPath.includes("/")) {
    return null;
  }

  return normalizedPath as ThreadId;
}

export function markPendingSettingsScrollRestore(threadId: ThreadId | null): void {
  pendingSettingsScrollRestoreThreadId = threadId;
}

export function consumePendingSettingsScrollRestore(threadId: ThreadId): boolean {
  if (pendingSettingsScrollRestoreThreadId !== threadId) {
    return false;
  }

  pendingSettingsScrollRestoreThreadId = null;
  return true;
}

export function clearPendingSettingsScrollRestore(): void {
  pendingSettingsScrollRestoreThreadId = null;
}
