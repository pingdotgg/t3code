import type { ScopedThreadRef } from "@t3tools/contracts";

/** Desktop ids must distinguish environments and server restarts; server tab ids are process-local. */
export function previewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, serverEpoch, tabId]);
}
