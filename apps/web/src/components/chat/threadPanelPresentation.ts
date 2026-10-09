import { useSyncExternalStore } from "react";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";

/**
 * Whether the workspace card docks inline or opens as a popover. The card decides from the
 * canvas it sits in and the header toggle reads it, so a change re-renders only those two
 * rather than the whole chat view.
 */
export interface ThreadPanelPresentationStore {
  readonly get: () => ThreadPanelPresentation;
  readonly set: (presentation: ThreadPanelPresentation) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createThreadPanelPresentationStore(): ThreadPanelPresentationStore {
  let presentation: ThreadPanelPresentation = "inline";
  const listeners = new Set<() => void>();
  return {
    get: () => presentation,
    set: (next) => {
      if (next === presentation) return;
      presentation = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useThreadPanelPresentation(store: ThreadPanelPresentationStore) {
  return useSyncExternalStore(store.subscribe, store.get);
}
