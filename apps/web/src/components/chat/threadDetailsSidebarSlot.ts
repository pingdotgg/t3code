import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useSyncExternalStore } from "react";

interface ThreadDetailsSidebarSlot {
  readonly threadKey: string;
  readonly element: HTMLElement;
}

// The sidebar registers the element under the open thread's row; the chat view's details
// card renders into it through a portal, so the card keeps its props and contexts.
let slot: ThreadDetailsSidebarSlot | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readSlot = () => slot;
const notify = () => {
  for (const listener of listeners) listener();
};

export function registerThreadDetailsSidebarSlot(threadKey: string, element: HTMLElement) {
  if (slot?.threadKey !== threadKey || slot.element !== element) {
    slot = { threadKey, element };
    notify();
  }
  return () => {
    if (slot?.element !== element) return;
    slot = null;
    notify();
  };
}

/** The sidebar element that holds this thread's details, while the sidebar shows it. */
export function useThreadDetailsSidebarSlot(threadRef: ScopedThreadRef | null): HTMLElement | null {
  const current = useSyncExternalStore(subscribe, readSlot, () => null);
  return current !== null && threadRef !== null && current.threadKey === scopedThreadKey(threadRef)
    ? current.element
    : null;
}
