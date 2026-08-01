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
interface PendingPanelClose {
  readonly snapshot: TerminalSurfaceSnapshot;
  /**
   * Earliest time the cached session list may settle this entry. The cached
   * list can predate the close attempt (a close that succeeded server-side but
   * reported interruption before the pruned metadata arrived), and restoring
   * from it would pin a dead pane the panel cannot reconcile away. Metadata
   * that arrives after the grace window has had time to reflect the close.
   */
  readonly readyAt: number;
}

const SETTLE_GRACE_MS = 1500;

const pendingByThreadKey = new Map<string, Map<string, PendingPanelClose>>();

// Recording can happen after the metadata that would settle it has already
// arrived (the close promise reports interruption late, or the session survived
// so the list never changes). Version + subscribe lets the settling effect
// re-run on every record instead of waiting for a metadata change that may
// never come.
let version = 0;
const listeners = new Set<() => void>();

function notifyPendingPanelCloses(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribePendingPanelCloses(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pendingPanelCloseVersion(): number {
  return version;
}

export function recordPendingPanelClose(
  threadKey: string,
  terminalId: string,
  snapshot: TerminalSurfaceSnapshot,
  now: number = Date.now(),
): void {
  const pending = pendingByThreadKey.get(threadKey) ?? new Map<string, PendingPanelClose>();
  pending.set(terminalId, { snapshot, readyAt: now + SETTLE_GRACE_MS });
  pendingByThreadKey.set(threadKey, pending);
  // One notification when the entry becomes eligible; metadata changes in the
  // meantime re-run the settling effect on their own but skip unready entries.
  setTimeout(notifyPendingPanelCloses, SETTLE_GRACE_MS);
}

/**
 * Settles every eligible pending close for a thread against the server's
 * session list, returning the ones whose session survived so the caller can
 * restore them — in reverse close order, so nested split closes reinsert at
 * their original pane positions. Ids the server no longer reports were really
 * closed and are simply dropped.
 *
 * `listLoaded` distinguishes an authoritative empty list (the closed terminal
 * was the last session — the entry must settle as closed) from metadata that
 * has not arrived yet, which must never settle anything.
 */
export function resolvePendingPanelCloses(
  threadKey: string,
  serverTerminalIds: readonly string[],
  now: number = Date.now(),
  listLoaded: boolean = serverTerminalIds.length > 0,
): Array<{ terminalId: string; snapshot: TerminalSurfaceSnapshot }> {
  const pending = pendingByThreadKey.get(threadKey);
  if (!pending || !listLoaded) return [];

  const serverIds = new Set(serverTerminalIds);
  const survived: Array<{ terminalId: string; snapshot: TerminalSurfaceSnapshot }> = [];
  for (const [terminalId, entry] of pending) {
    if (entry.readyAt > now) continue;
    pending.delete(terminalId);
    if (serverIds.has(terminalId)) {
      survived.push({ terminalId, snapshot: entry.snapshot });
    }
  }
  if (pending.size === 0) {
    pendingByThreadKey.delete(threadKey);
  }
  return survived.reverse();
}

export function clearPendingPanelCloses(threadKey: string): void {
  pendingByThreadKey.delete(threadKey);
}
