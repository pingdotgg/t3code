/**
 * Threads the user settled from this device this session (row menu, drag
 * to the shelf, chat header, closing its tab). See useSettleOnLayoutClose.
 */
const settledByUser = new Set<string>();

export function markThreadSettledByUser(threadKey: string): void {
  settledByUser.add(threadKey);
}

export function forgetThreadSettledByUser(threadKey: string): void {
  settledByUser.delete(threadKey);
}

/**
 * Whether a settled thread was settled on purpose from this device. Only
 * those leave the active list while still open in the layout; the server's
 * own settlement (a merge) waits for the tab to close.
 */
export function wasThreadSettledByUser(threadKey: string): boolean {
  return settledByUser.has(threadKey);
}
