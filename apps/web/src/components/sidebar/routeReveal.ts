import { useRef } from "react";

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
  const glideRef = useRef<{ animation: Animation; offset: number } | null>(null);
  pendingSidebarRouteReveal(reveal, routeKey);
  return (row: HTMLElement | null, rowKey: string) => {
    if (row === null) return;
    if (reveal.pendingKey !== rowKey && !mountRevealOwed.current) return;
    completeSidebarRouteReveal(reveal);
    const glide =
      !mountRevealOwed.current &&
      !row.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mountRevealOwed.current = false;
    const previous = glideRef.current;
    const carried = previous
      ? previous.offset * (1 - (previous.animation.effect?.getComputedTiming().progress ?? 1))
      : 0;
    previous?.animation.cancel();
    glideRef.current = null;
    // A hovered row is already visible; avoid forcing layout during its click commit.
    if (row.matches(":hover")) return;
    const scroller = glide ? row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') : null;
    const from = scroller?.scrollTop ?? 0;
    row.scrollIntoView({ block: "nearest", behavior: "instant" });
    const list = row.closest("li")?.parentElement;
    if (!scroller || !list) return;
    const moved = scroller.scrollTop - from;
    const offset = moved + carried;
    if (offset === 0 || Math.abs(moved) > scroller.clientHeight / 4) return;
    const animation = list.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
      { duration: 200, easing: "ease-out" },
    );
    glideRef.current = { animation, offset };
  };
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
