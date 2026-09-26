import type { NavigationState } from "@react-navigation/native";

export type AdaptiveNavigationAction = "push" | "replace";

type ThreadParams = ReactNavigation.RootParamList["Thread"];

/**
 * A persistent sidebar replaces the whole workspace, leaving Home beneath the
 * selected thread. The thread already on the stack is reused so the chat
 * updates in place.
 */
export function resolveSplitThreadSelectionState(state: NavigationState, params: ThreadParams) {
  const thread = state.routes.findLast((route) => route.name === "Thread");
  return {
    ...state,
    index: 1,
    routes: [
      ...state.routes.slice(0, 1),
      thread ? { ...thread, params } : { name: "Thread", params },
    ],
  };
}

/** Dismiss sheets and select their underlying workspace destination in one stack update. */
export function resolveCompactThreadSelectionOverlayState(input: {
  readonly state: NavigationState;
  readonly workspaceRouteKey: string | undefined;
  readonly params: ThreadParams;
}) {
  const workspaceIndex = input.state.routes.findIndex(
    (route) => route.key === input.workspaceRouteKey,
  );
  if (workspaceIndex < 0 || workspaceIndex >= input.state.index) return null;

  const routes = input.state.routes.slice(0, workspaceIndex + 1);
  return {
    ...input.state,
    index: routes.length,
    routes: [...routes, { name: "Thread", params: input.params }],
  };
}

/**
 * On regular-width layouts, the file browser and preview occupy one workspace
 * destination. Replacing the browser route keeps a single back step to chat.
 * Compact layouts retain the browser as the previous stack screen.
 */
export function resolveFileSelectionNavigationAction(input: {
  readonly hasPersistentFileInspector: boolean;
}): AdaptiveNavigationAction {
  return input.hasPersistentFileInspector ? "replace" : "push";
}
