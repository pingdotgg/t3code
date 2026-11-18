import type { ScopedThreadRef } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";

const WINDOW_INSTANCE_ID_KEY = "t3code:window-instance-id:v1";
let windowInstanceId: string | null = null;

// Kept across reloads so a reloaded window re-registers the tabs it already hosted.
function readWindowInstanceId(): string {
  if (windowInstanceId !== null) return windowInstanceId;
  try {
    windowInstanceId = window.sessionStorage.getItem(WINDOW_INSTANCE_ID_KEY);
    if (windowInstanceId === null) {
      windowInstanceId = randomUUID();
      window.sessionStorage.setItem(WINDOW_INSTANCE_ID_KEY, windowInstanceId);
    }
  } catch {
    windowInstanceId ??= randomUUID();
  }
  return windowInstanceId;
}

/** Names one preview tab the same in every app window; desktop ownership is keyed by it. */
export function previewSessionKey(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, serverEpoch, tabId]);
}

/**
 * Desktop ids must distinguish environments and server restarts, since server tab ids are
 * process-local, and app windows, since each window hosts its own webview for a tab.
 */
export function previewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return JSON.stringify([
    threadRef.environmentId,
    threadRef.threadId,
    serverEpoch,
    tabId,
    readWindowInstanceId(),
  ]);
}
