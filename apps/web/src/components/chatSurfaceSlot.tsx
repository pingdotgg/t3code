import { useSyncExternalStore, type ReactNode } from "react";

let surface: ReactNode = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Register lazily in the root so full-page navigation preserves the chat surface. */
export function registerChatSurface(element: ReactNode) {
  if (surface !== null) return;
  surface = element;
  for (const listener of listeners) listener();
}

export function ChatSurfaceSlot() {
  return useSyncExternalStore(subscribe, () => surface);
}
