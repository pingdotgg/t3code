import { useEffect, useRef } from "react";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";

import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

// AppSidebarLayout owns this so drawer and Settings remounts preserve the chosen project scope.
// Only route changes may widen that scope; scroll position is lost on remount.
// Leaving Settings commits the router's location before its matches, briefly hiding thread params.
// Ignore null keys so the same thread does not look new during that gap.
export interface SidebarRouteReveal {
  observedKey: string | null;
  pendingKey: string | null;
  restoredRouteKey?: string | null;
}

export function pendingSidebarRouteReveal(
  reveal: SidebarRouteReveal,
  routeKey: string | null,
): string | null {
  if (routeKey === null) return null;
  if (reveal.observedKey !== routeKey) {
    reveal.observedKey = routeKey;
    reveal.pendingKey = routeKey;
  }
  return reveal.pendingKey;
}

export function completeSidebarRouteReveal(
  reveal: SidebarRouteReveal,
  heldRouteKey?: string | null,
): void {
  reveal.pendingKey = null;
  if (heldRouteKey !== undefined) reveal.restoredRouteKey = heldRouteKey;
}

// Each route change and each mount scroll to the open thread once. Render records
// the route, so a thread left before its row mounted still counts as a change.
// The row can mount after the route, once its shells arrive, so its ref scrolls.
export function useActiveRowReveal(reveal: SidebarRouteReveal, routeKey: string | null) {
  const mountRevealOwed = useRef(true);
  pendingSidebarRouteReveal(reveal, routeKey);
  return (row: HTMLElement | null, rowKey: string) => {
    if (row === null) return;
    if (reveal.pendingKey !== rowKey && !mountRevealOwed.current) return;
    completeSidebarRouteReveal(reveal);
    mountRevealOwed.current = false;
    row.scrollIntoView({ block: "nearest" });
  };
}

type RevealableThread = Parameters<typeof filterSidebarV2VisibleThreads>[0][number];

export function useSidebarScopeRoutePersistence(input: {
  readonly widensScope: boolean;
  readonly routeKey: string | null;
}) {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectCollection = useUiStateStore((state) => state.selectProjectCollection);
  const heldRouteKey = useUiStateStore((state) => state.sidebarScopeRouteKey);
  const holdScopeRoute = useUiStateStore((state) => state.holdSidebarScopeRoute);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists route-driven scope changes and releases saved holds when navigation leaves their thread
  useEffect(() => {
    if (input.widensScope) {
      clearSelection();
      selectCollection(null, null);
    } else if (
      input.routeKey !== null &&
      heldRouteKey !== null &&
      input.routeKey !== heldRouteKey
    ) {
      holdScopeRoute(null);
    }
  }, [
    clearSelection,
    input.widensScope,
    selectCollection,
    input.routeKey,
    heldRouteKey,
    holdScopeRoute,
  ]);
}

// Render records the route before deciding, so the first render of a new route
// already widens the scope. Only a route reveal widens: the once-per-mount
// scroll never changes a scope the user chose.
export function resolveSidebarRouteReveal<T extends RevealableThread>(input: {
  readonly reveal: SidebarRouteReveal;
  readonly routeKey: string | null;
  readonly rawRouteKey?: string | null;
  readonly isSearching: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly findThread: (key: string) => T | undefined;
}): { readonly pendingKey: string | null; readonly widensScope: boolean } {
  const { reveal, routeKey, isSearching, scopedProjectKeys, delegatedUnderParent, findThread } =
    input;
  if (
    reveal.restoredRouteKey != null &&
    input.rawRouteKey != null &&
    input.rawRouteKey !== reveal.restoredRouteKey
  ) {
    reveal.restoredRouteKey = null;
    reveal.pendingKey = routeKey;
  }
  const pendingKey = pendingSidebarRouteReveal(reveal, routeKey);
  // Search results replace the thread list; the reveal waits for it to return.
  const thread = pendingKey === null || isSearching ? undefined : findThread(pendingKey);
  const widensScope =
    reveal.restoredRouteKey == null &&
    thread !== undefined &&
    scopedProjectKeys !== null &&
    filterSidebarV2VisibleThreads([thread], scopedProjectKeys, delegatedUnderParent).length === 0 &&
    filterSidebarV2VisibleThreads([thread], null, delegatedUnderParent).length === 1;
  return { pendingKey, widensScope };
}
