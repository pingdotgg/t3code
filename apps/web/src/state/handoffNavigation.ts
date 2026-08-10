import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export interface PendingHandoffNavigation {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Where to land once a moved thread's shell arrives.
 *
 * This lives outside React because the component that starts a move does not
 * survive it: the departed thread drops out of the sidebar, the selection
 * fallback swaps the route, and the thread view remounts — taking any
 * component-held "navigate when it lands" state with it. A module store lets
 * an always-mounted surface carry the follow-through instead.
 */
let pending: PendingHandoffNavigation | null = null;
const listeners = new Set<() => void>();

export function setPendingHandoffNavigation(next: PendingHandoffNavigation | null): void {
  pending = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingHandoffNavigation(): PendingHandoffNavigation | null {
  return useSyncExternalStore(subscribe, () => pending);
}
