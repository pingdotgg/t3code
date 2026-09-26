/**
 * Epoch-scoped runtime tab identity — the package port of the native
 * previewRuntimeTabId helper (binding table row #24).
 *
 * The server only guarantees preview tab ids are unique within one process.
 * Anything that outlives a server restart (session keys, presentation
 * leases, the coming `t3.browser/sessions` contract) needs the stronger
 * identity that also changes when the process does — which is exactly why
 * the server epoch is part of the serialization. Output is byte-identical
 * to the native helper for the same inputs.
 *
 * The native signature takes a branded `ScopedThreadRef`; the plugin's
 * `ViewContext.resource` carries plain strings, so this takes the
 * structural shape a ScopedThreadRef is assignable to.
 */
export interface RuntimeTabRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export function previewRuntimeTabId(
  threadRef: RuntimeTabRef,
  serverEpoch: string | null,
  tabId: string,
): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, serverEpoch, tabId]);
}

export function isCurrentPreviewRuntimeTab(
  threadRef: RuntimeTabRef,
  serverEpoch: string | null,
  tabId: string,
  runtimeTabId: string,
): boolean {
  return previewRuntimeTabId(threadRef, serverEpoch, tabId) === runtimeTabId;
}
