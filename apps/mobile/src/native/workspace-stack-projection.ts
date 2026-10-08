import type {
  NavigationState,
  ParamListBase,
  StackNavigationState,
} from "@react-navigation/native";

type Route = StackNavigationState<ParamListBase>["routes"][number];

/** Project one router history into native columns and a modal presentation stack. */
export function projectWorkspaceStack(
  state: StackNavigationState<ParamListBase>,
  isOverlay: (route: Route) => boolean,
) {
  const firstOverlay = state.routes.findIndex(isOverlay);
  const workspaceRoutes = state.routes.slice(0, firstOverlay < 0 ? undefined : firstOverlay);
  const primary = workspaceRoutes.find((route) => route.name === "Home");
  const detail = workspaceRoutes.filter((route) => route.name !== "Home");
  const overlays = firstOverlay < 0 ? [] : state.routes.slice(firstOverlay);
  return { primary, detail, overlays };
}

/** Native callbacks can arrive after a JS pop or replace; those must not pop the next screen. */
export function nativeWorkspacePopCount(
  state: Pick<NavigationState, "index" | "routes">,
  dismissedKey: string,
): number {
  const index = state.routes.findIndex((route) => route.key === dismissedKey);
  return index <= 0 || index > state.index ? 0 : state.index - index + 1;
}

/** POP counts backwards from its source, so dismiss a group from the active descendant. */
export function nativeWorkspacePopAction(
  state: Pick<NavigationState, "key" | "index" | "routes">,
  dismissedKey: string,
) {
  const count = nativeWorkspacePopCount(state, dismissedKey);
  return count
    ? {
        type: "POP" as const,
        payload: { count },
        source: state.routes[state.index]!.key,
        target: state.key,
      }
    : null;
}

/** Group pushes with the modal that owns their native stack. */
export function partitionStackPresentations<T>(
  routes: readonly T[],
  isModal: (route: T) => boolean,
): T[][] {
  const groups: T[][] = [];
  for (const route of routes) {
    if (groups.length === 0 || isModal(route)) groups.push([]);
    groups.at(-1)!.push(route);
  }
  return groups;
}

/** Keep outgoing screens in place until dismissal; Fabric moves enqueue native pop/push operations. */
export function reconcileStackScreens<T extends { readonly key: string }>(
  previous: readonly T[],
  current: readonly T[],
  completedNativeDismissals: ReadonlySet<string> = new Set(),
): T[] {
  const active = new Set(current.map((route) => route.key));
  const screens = [...current];
  previous.forEach((route, index) => {
    if (!active.has(route.key) && !completedNativeDismissals.has(route.key)) {
      screens.splice(Math.min(index, screens.length), 0, route);
    }
  });
  return screens;
}
