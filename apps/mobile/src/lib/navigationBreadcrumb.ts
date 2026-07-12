import type { NavigationState, PartialState } from "@react-navigation/native";

import { addBreadcrumb } from "./breadcrumbs";

type NavState = NavigationState | PartialState<NavigationState> | undefined;

/** Best-effort route path for crash breadcrumbs (e.g. Root/Thread). */
export function routePathFromNavigationState(state: NavState): string {
  if (state === undefined || !("routes" in state) || state.routes === undefined) {
    return "";
  }
  const index = "index" in state && typeof state.index === "number" ? state.index : 0;
  const route = state.routes[index];
  if (route === undefined) {
    return "";
  }
  const nested = routePathFromNavigationState(route.state as NavState);
  return nested.length > 0 ? `${route.name}/${nested}` : String(route.name);
}

export function recordNavigationBreadcrumb(state: NavState): void {
  const path = routePathFromNavigationState(state);
  if (path.length === 0) {
    return;
  }
  addBreadcrumb("nav", { path });
}
