export type AdaptiveNavigationAction = "push" | "replace" | "set-params";

const BASE_THREAD_ROUTE_PATTERN = /^\/threads\/[^/]+\/[^/]+\/?$/;

/** Task tool links keep optional task context in the existing tool route query. */
export function parseActiveTaskPath(
  pathname: string,
): { environmentId: string; taskId: string } | null {
  try {
    const match = /^\/tasks\/([^/]+)\/([^/?]+)(?:\/|\?|$)/.exec(pathname);
    if (match)
      return {
        environmentId: decodeURIComponent(match[1]!),
        taskId: decodeURIComponent(match[2]!),
      };
    const tool = /^\/threads\/([^/]+)\/.*(?:files|terminal)(?:\/|\?|$)/.exec(pathname);
    const taskId = new URLSearchParams(pathname.split("?")[1] ?? "").get("taskId");
    return tool && taskId ? { environmentId: decodeURIComponent(tool[1]!), taskId } : null;
  } catch {
    return null;
  }
}

export function resolveTaskSelectionNavigationAction(input: {
  readonly usesSplitView: boolean;
  readonly pathname: string;
}): AdaptiveNavigationAction {
  if (!input.usesSplitView || input.pathname === "/") return "push";
  return /^\/tasks\/[^/]+\/[^/?]+\/?$/.test(input.pathname) ? "set-params" : "replace";
}

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
