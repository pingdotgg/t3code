import { createContext, useMemo, useState } from "react";

/** Closes the inspector from its bar: hides the column, or dismisses the sheet. */
export const InspectorCloseContext = createContext<(() => void) | null>(null);

const NO_ROUTES: ReadonlyMap<string, object> = new Map();

/** The options a pane's AppBar sets. External so a write re-renders the bar, not the pane. */
function createInspectorBarStore() {
  let snapshot: object | undefined;
  const listeners = new Set<() => void>();
  return {
    set(options: object) {
      snapshot = { ...snapshot, ...options };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

export type InspectorBarStore = ReturnType<typeof createInspectorBarStore>;

/** Routes a pane's AppBar options into its own bar instead of the thread route's. */
export function useInspectorBarSlot() {
  const [store] = useState(createInspectorBarStore);
  const slot = useMemo(
    () => ({
      byRoute: NO_ROUTES,
      set: (_routeKey: string, options: object) => store.set(options),
    }),
    [store],
  );
  return { store, slot };
}
