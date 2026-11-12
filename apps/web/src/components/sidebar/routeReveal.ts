import { useRef } from "react";

import { observeResize } from "~/lib/observeResize";

import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

// AppSidebarLayout owns this so drawer and Settings remounts preserve the chosen project scope.
// Only route changes may widen that scope; scroll position is lost on remount.
// Leaving Settings commits the router's location before its matches, briefly hiding thread params.
// Ignore null keys so the same thread does not look new during that gap.
export interface SidebarRouteReveal {
  observedKey: string | null;
  pendingKey: string | null;
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

export function completeSidebarRouteReveal(reveal: SidebarRouteReveal): void {
  reveal.pendingKey = null;
}

// Each route change and each mount scroll to the open thread once. Render records
// the route, so a thread left before its row mounted still counts as a change.
// The row can mount after the route, once its shells arrive, so its ref scrolls.
export function useActiveRowReveal(reveal: SidebarRouteReveal, routeKey: string | null) {
  const mountRevealOwed = useRef(true);
  pendingSidebarRouteReveal(reveal, routeKey);
  // Returns a ref cleanup while it waits on a hidden row, so an unmount releases the wait.
  const revealRow = (row: HTMLElement | null, rowKey: string): (() => void) | undefined => {
    if (row === null) return undefined;
    if (reveal.pendingKey !== rowKey && !mountRevealOwed.current) return undefined;
    // The closed narrow sheet keeps rows mounted but hidden, and opening it does not
    // re-render them, so wait for the row to get a box before spending the reveal.
    if (row.getClientRects().length === 0) {
      const stopWaiting = observeResize(row, () => {
        if (row.getClientRects().length === 0) return;
        stopWaiting();
        revealRow(row, rowKey);
      });
      return stopWaiting;
    }
    completeSidebarRouteReveal(reveal);
    mountRevealOwed.current = false;
    // A row under the pointer was just clicked, so it is in view; scrolling it would force a
    // layout mid-commit. Keyboard activation can come from a focused row scrolled out of view.
    if (row.matches(":hover")) return undefined;
    row.scrollIntoView({ block: "nearest" });
    return undefined;
  };
  return revealRow;
}

type RevealableThread = Parameters<typeof filterSidebarV2VisibleThreads>[0][number];

// Render records the route before deciding, so the first render of a new route
// already widens the scope. Only a route reveal widens: the once-per-mount
// scroll never changes a scope the user chose.
export function resolveSidebarRouteReveal<T extends RevealableThread>(input: {
  readonly reveal: SidebarRouteReveal;
  readonly routeKey: string | null;
  readonly isSearching: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly findThread: (key: string) => T | undefined;
}): { readonly pendingKey: string | null; readonly widensScope: boolean } {
  const { reveal, routeKey, isSearching, scopedProjectKeys, delegatedUnderParent, findThread } =
    input;
  const pendingKey = pendingSidebarRouteReveal(reveal, routeKey);
  // Search results replace the thread list; the reveal waits for it to return.
  const thread = pendingKey === null || isSearching ? undefined : findThread(pendingKey);
  const widensScope =
    thread !== undefined &&
    scopedProjectKeys !== null &&
    filterSidebarV2VisibleThreads([thread], scopedProjectKeys, delegatedUnderParent).length === 0 &&
    filterSidebarV2VisibleThreads([thread], null, delegatedUnderParent).length === 1;
  return { pendingKey, widensScope };
}
