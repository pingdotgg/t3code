import { createContext, use, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

import { WorkspaceSlotOptionsContext } from "../../native/v5-workspace-context";

/** Closes the inspector from its bar: hides the column, or dismisses the sheet. */
export const InspectorCloseContext = createContext<(() => void) | null>(null);

const ROOT = "root";
const NO_ROUTES: ReadonlyMap<string, object> = new Map();

/**
 * The bar options each inspector pane's AppBar sets. Panes stay mounted while hidden, so the bar
 * shows only the visible pane's options. External so a write re-renders the bar, not the panes.
 */
export function createInspectorBarStore() {
  const byOwner = new Map<string, object>();
  const listeners = new Set<() => void>();
  let shown = ROOT;
  let snapshot: object | undefined;
  const emit = () => {
    snapshot = byOwner.get(shown);
    for (const listener of listeners) listener();
  };
  return {
    set(owner: string, options: object) {
      byOwner.set(owner, { ...byOwner.get(owner), ...options });
      if (owner === shown) emit();
    },
    show(owner: string) {
      if (shown === owner) return;
      shown = owner;
      emit();
    },
    remove(owner: string) {
      byOwner.delete(owner);
      if (shown === owner) shown = ROOT;
      emit();
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

const InspectorBarStoreContext = createContext<InspectorBarStore | null>(null);

function useOwnerSlot(store: InspectorBarStore | null, owner: string) {
  return useMemo(
    () =>
      store && {
        byRoute: NO_ROUTES,
        set: (_routeKey: string, options: object) => store.set(owner, options),
      },
    [store, owner],
  );
}

/** Routes the AppBar options of the inspector's content into its bar instead of the route's. */
export function InspectorBarScope(props: {
  readonly store: InspectorBarStore;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const slot = useOwnerSlot(props.store, ROOT);
  return (
    <InspectorBarStoreContext value={props.store}>
      <InspectorCloseContext value={props.onClose}>
        <WorkspaceSlotOptionsContext value={slot}>{props.children}</WorkspaceSlotOptionsContext>
      </InspectorCloseContext>
    </InspectorBarStoreContext>
  );
}

/** One of several panes the inspector keeps mounted; the bar follows the visible one. */
export function InspectorBarOwner(props: {
  readonly id: string;
  readonly visible: boolean;
  readonly children: ReactNode;
}) {
  const store = use(InspectorBarStoreContext);
  const slot = useOwnerSlot(store, props.id);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- points the out-of-tree inspector bar at the visible pane's options
  useLayoutEffect(() => {
    if (store && props.visible) store.show(props.id);
  }, [store, props.id, props.visible]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops an unmounted pane's options from the out-of-tree inspector bar
  useLayoutEffect(() => (store ? () => store.remove(props.id) : undefined), [store, props.id]);
  if (!slot) return props.children;
  return <WorkspaceSlotOptionsContext value={slot}>{props.children}</WorkspaceSlotOptionsContext>;
}

export function useInspectorBarStore() {
  return useState(createInspectorBarStore)[0];
}
