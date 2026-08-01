import type { TerminalSurfaceSnapshot } from "../rightPanelStore";

/**
 * Right-panel closes whose outcome the server never confirmed, keyed by thread.
 *
 * An interrupted `terminal.close` is not evidence either way: the optimistic
 * removal already took the pane out of its surface, so rolling back blind would
 * either strand a live split terminal in the drawer or pin a dead pane the panel
 * has no reconcile pass to remove. Holding the pre-close snapshot until
 * authoritative session metadata arrives lets the outcome decide.
 */
const pendingByThreadKey = new Map<string, Map<string, TerminalSurfaceSnapshot>>();

export function recordPendingPanelClose(
  threadKey: string,
  terminalId: string,
  snapshot: TerminalSurfaceSnapshot,
): void {
  const pending = pendingByThreadKey.get(threadKey) ?? new Map<string, TerminalSurfaceSnapshot>();
  pending.set(terminalId, snapshot);
  pendingByThreadKey.set(threadKey, pending);
}

/**
 * Settles every pending close for a thread against the server's session list,
 * returning the ones whose session survived so the caller can restore them.
 * Ids the server no longer reports were really closed and are simply dropped.
 *
 * `serverTerminalIds` must be a loaded, non-empty list: an empty one is
 * indistinguishable from metadata that has not arrived, and would resolve every
 * entry as "closed".
 */
export function resolvePendingPanelCloses(
  threadKey: string,
  serverTerminalIds: readonly string[],
): Array<{ terminalId: string; snapshot: TerminalSurfaceSnapshot }> {
  const pending = pendingByThreadKey.get(threadKey);
  if (!pending || serverTerminalIds.length === 0) return [];

  const serverIds = new Set(serverTerminalIds);
  const survived: Array<{ terminalId: string; snapshot: TerminalSurfaceSnapshot }> = [];
  for (const [terminalId, snapshot] of pending) {
    if (serverIds.has(terminalId)) {
      survived.push({ terminalId, snapshot });
    }
  }
  pendingByThreadKey.delete(threadKey);
  return survived;
}

export function clearPendingPanelCloses(threadKey: string): void {
  pendingByThreadKey.delete(threadKey);
}
