import type { ScopedThreadRef } from "@t3tools/contracts";

type SettleAndAdvance = (threadRef: ScopedThreadRef) => void;

let registeredSettleAndAdvance: SettleAndAdvance | null = null;

export function registerSettleAndAdvance(handler: SettleAndAdvance): () => void {
  registeredSettleAndAdvance = handler;
  return () => {
    if (registeredSettleAndAdvance === handler) registeredSettleAndAdvance = null;
  };
}

/**
 * Returns false when no sidebar is mounted, so the caller settles in place.
 */
export function settleAndAdvance(threadRef: ScopedThreadRef): boolean {
  if (!registeredSettleAndAdvance) return false;
  registeredSettleAndAdvance(threadRef);
  return true;
}
