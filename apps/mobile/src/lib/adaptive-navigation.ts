export type AdaptiveNavigationAction = "push" | "replace" | "set-params";
export type WorkspaceDetailInvalidationAction<
  Route extends { readonly key: string; readonly name: string } = {
    readonly key: string;
    readonly name: string;
  },
> =
  | {
      readonly type: "pop";
      readonly count: number;
      readonly source: string;
    }
  | {
      readonly type: "reset";
      readonly routes: ReadonlyArray<Route | { readonly name: "Home" }>;
    };

const BASE_THREAD_ROUTE_PATTERN = /^\/threads\/[^/]+\/[^/]+\/?$/;

export function isBaseThreadRoute(pathname: string): boolean {
  return BASE_THREAD_ROUTE_PATTERN.test(pathname);
}

/**
 * A persistent sidebar selects a peer destination in place. A compact list
 * drills into a new destination so the native back stack remains available.
 * From Home the selection pushes (never replaces) so Home stays beneath the
 * thread — collapsing back to a compact width keeps a sane back stack.
 */
export function resolveThreadSelectionNavigationAction(input: {
  readonly usesSplitView: boolean;
  readonly pathname: string;
}): AdaptiveNavigationAction {
  if (!input.usesSplitView || input.pathname === "/") {
    return "push";
  }

  return isBaseThreadRoute(input.pathname) ? "set-params" : "replace";
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

export function shouldInvalidateSelectedThreadDetail(input: {
  readonly previous: {
    readonly key: string | null;
    readonly present: boolean;
    readonly settled: boolean;
    readonly snoozed: boolean;
  };
  readonly current: {
    readonly key: string | null;
    readonly present: boolean;
    readonly settled: boolean;
    readonly snoozed: boolean;
  };
}): boolean {
  return (
    input.previous.key !== null &&
    input.previous.key === input.current.key &&
    input.previous.present &&
    (!input.current.present ||
      (!input.previous.settled && input.current.settled) ||
      (!input.previous.snoozed && input.current.snoozed))
  );
}

export function resolveWorkspaceDetailInvalidationAction<
  Route extends { readonly key: string; readonly name: string },
>(input: {
  readonly routes: ReadonlyArray<Route>;
  readonly overlayRouteNames: ReadonlySet<string>;
}): WorkspaceDetailInvalidationAction<Route> | null {
  let workspaceRouteIndex = -1;
  for (let index = input.routes.length - 1; index >= 0; index -= 1) {
    const route = input.routes[index];
    if (route !== undefined && !input.overlayRouteNames.has(route.name)) {
      workspaceRouteIndex = index;
      break;
    }
  }
  if (workspaceRouteIndex === -1) {
    return null;
  }

  const workspaceRoute = input.routes[workspaceRouteIndex];
  if (workspaceRoute === undefined || workspaceRoute.name === "Home") {
    return null;
  }

  let homeRouteIndex = -1;
  for (let index = workspaceRouteIndex - 1; index >= 0; index -= 1) {
    if (input.routes[index]?.name === "Home") {
      homeRouteIndex = index;
      break;
    }
  }
  if (homeRouteIndex === -1) {
    return {
      type: "reset",
      routes: [{ name: "Home" }, ...input.routes.slice(workspaceRouteIndex + 1)],
    };
  }

  return {
    type: "pop",
    count: workspaceRouteIndex - homeRouteIndex,
    source: workspaceRoute.key,
  };
}
