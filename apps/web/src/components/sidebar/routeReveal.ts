// Owned by AppSidebarLayout because the narrow drawer and Settings unmount the
// thread sidebar without changing the route. Only a route change requests a
// reveal that may widen the project scope, so a scope chosen while one thread
// stays open survives a remount. Scroll position does not survive one.
//
// A null key is not an observation: leaving Settings commits the router's
// location before its matches, so the sidebar's first render can read no
// thread params. Recording that would make the same thread look new.
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
