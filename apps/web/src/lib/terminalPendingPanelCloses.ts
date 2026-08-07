import type { TerminalSurfaceSnapshot } from "../rightPanelStore";

/**
 * Right-panel closes whose outcome the server has not confirmed yet.
 *
 * An interrupted close is not evidence that the session survived or ended.
 * Holding the pre-close snapshot until fresh metadata settles the outcome
 * prevents both a dead pane being resurrected and a live pane being adopted by
 * the drawer in the wrong layout.
 */
interface PendingPanelClose {
  readonly snapshot: TerminalSurfaceSnapshot;
  readonly readyAt: number;
}

const SETTLE_GRACE_MS = 1_500;
const pendingByThreadKey = new Map<string, Map<string, PendingPanelClose>>();
const timersByThreadKey = new Map<string, ReturnType<typeof setTimeout>>();

let version = 0;
const listeners = new Set<() => void>();

function notifyPendingPanelCloses(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

function clearTimer(threadKey: string): void {
  const timer = timersByThreadKey.get(threadKey);
  if (timer === undefined) return;
  clearTimeout(timer);
  timersByThreadKey.delete(threadKey);
}

function earliestReadyAt(pending: Map<string, PendingPanelClose>): number {
  let readyAt = Number.POSITIVE_INFINITY;
  for (const entry of pending.values()) {
    readyAt = Math.min(readyAt, entry.readyAt);
  }
  return readyAt;
}

function scheduleNotification(
  threadKey: string,
  pending: Map<string, PendingPanelClose>,
  delayMs?: number,
): void {
  clearTimer(threadKey);
  const nextReadyAt = earliestReadyAt(pending);
  timersByThreadKey.set(
    threadKey,
    setTimeout(
      () => {
        timersByThreadKey.delete(threadKey);
        if (pendingByThreadKey.get(threadKey) === pending) {
          notifyPendingPanelCloses();
          if (pending.size > 0) {
            const nextReadyAt = earliestReadyAt(pending);
            if (nextReadyAt > Date.now()) {
              scheduleNotification(threadKey, pending, nextReadyAt - Date.now());
            }
          }
        }
      },
      delayMs ?? Math.max(0, nextReadyAt - Date.now()),
    ),
  );
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
  scheduleNotification(threadKey, pending);
}

/**
 * A newly opened session with the same id supersedes an old interrupted close.
 * Do not let the old snapshot restore over the new session later.
 */
export function clearPendingPanelClose(threadKey: string, terminalId: string): void {
  const pending = pendingByThreadKey.get(threadKey);
  if (!pending?.delete(terminalId)) return;
  if (pending.size === 0) {
    pendingByThreadKey.delete(threadKey);
    clearTimer(threadKey);
    return;
  }
  scheduleNotification(threadKey, pending);
}

/**
 * Settles eligible entries against authoritative server metadata. Surviving
 * sessions are returned in reverse close order so nested split closes restore
 * their original pane order. Sessions absent from metadata are confirmed
 * closed and are discarded.
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
    clearTimer(threadKey);
  } else {
    scheduleNotification(threadKey, pending);
  }
  return survived.toReversed();
}

export function clearPendingPanelCloses(threadKey: string): void {
  pendingByThreadKey.delete(threadKey);
  clearTimer(threadKey);
}
