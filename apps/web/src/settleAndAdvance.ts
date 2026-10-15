import type { ScopedThreadRef } from "@t3tools/contracts";

type SettleAndAdvance = (threadRef: ScopedThreadRef) => void;

// Only the mounted thread sidebar knows the card order that picks the next
// thread, so it registers its settle action here for other entry points.
let registeredSettleAndAdvance: SettleAndAdvance | null = null;

/**
 * Called by the thread sidebar while it is mounted. Returns the unregister
 * function, which leaves a newer registration in place.
 */
export function registerSettleAndAdvance(handler: SettleAndAdvance): () => void {
  registeredSettleAndAdvance = handler;
  return () => {
    if (registeredSettleAndAdvance === handler) registeredSettleAndAdvance = null;
  };
}

/**
 * Settles the open thread the way the sidebar Settle button does: settle,
 * then move to the next thread. Used by the `thread.settle` shortcut.
 * Returns false when no sidebar is mounted, so the caller settles in place.
 */
export function settleAndAdvance(threadRef: ScopedThreadRef): boolean {
  if (!registeredSettleAndAdvance) return false;
  registeredSettleAndAdvance(threadRef);
  return true;
}
