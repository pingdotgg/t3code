import type {
  NavigationState,
  ParamListBase,
  StackNavigationState,
} from "@react-navigation/native";

type Route = StackNavigationState<ParamListBase>["routes"][number];

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

/** A native card pop must preserve pushes made before its completion event reaches JS. */
export function nativeStackPopAction(
  state: Pick<NavigationState, "key" | "index" | "routes">,
  dismissedKey: string,
  destinationKey?: string,
) {
  const sourceIndex = state.routes.findIndex((route) => route.key === dismissedKey);
  const destinationIndex =
    destinationKey === undefined
      ? sourceIndex - 1
      : state.routes.findIndex((route) => route.key === destinationKey);
  if (
    sourceIndex <= 0 ||
    sourceIndex > state.index ||
    destinationIndex < 0 ||
    destinationIndex >= sourceIndex
  ) {
    return null;
  }
  return {
    type: "POP" as const,
    payload: { count: sourceIndex - destinationIndex },
    source: dismissedKey,
    target: state.key,
  };
}

/** The column UIKit shows while a split is collapsed, and the active detail it began removing. */
export interface CollapsedSplitColumn {
  readonly visible: "primary" | "secondary";
  readonly leaving: string | null;
}

/**
 * A collapsed split nests the detail column's navigation controller in the list column's. Back
 * from the detail root pops that controller whole, so no screen leaves its own stack or reports a
 * dismissal: the list appearing after the active detail began leaving is the only sign of it.
 */
export function collapsedSplitTransition(
  column: CollapsedSplitColumn,
  event: { readonly type: "willAppear" | "didAppear" | "willDisappear"; readonly key: string },
  state: Pick<NavigationState, "key" | "index" | "routes">,
  primaryKey: string,
): {
  readonly column: CollapsedSplitColumn;
  readonly pop: ReturnType<typeof nativeStackPopAction>;
} {
  switch (event.type) {
    case "willDisappear":
      // JS pushes, pops, and presentations have already moved the router past this screen.
      return {
        column:
          state.index > 0 && state.routes[state.index]?.key === event.key
            ? { ...column, leaving: event.key }
            : column,
        pop: null,
      };
    case "willAppear":
      // A cancelled swipe, or an expansion that keeps the detail on screen.
      return {
        column: column.leaving === event.key ? { ...column, leaving: null } : column,
        pop: null,
      };
    case "didAppear":
      return {
        column: { visible: event.key === primaryKey ? "primary" : "secondary", leaving: null },
        pop:
          event.key === primaryKey && column.leaving
            ? nativeStackPopAction(state, column.leaving, primaryKey)
            : null,
      };
  }
}

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
