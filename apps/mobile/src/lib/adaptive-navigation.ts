export type AdaptiveNavigationAction = "push" | "replace" | "set-params";
export type ThreadListAction =
  | "archive"
  | "unarchive"
  | "delete"
  | "settle"
  | "unsettle"
  | "snooze"
  | "unsnooze";

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

/**
 * Removing the selected thread from the live sidebar also invalidates its
 * persistent detail pane. Reverse actions keep the current detail visible.
 */
export function shouldInvalidateSelectedThreadDetail(input: {
  readonly action: ThreadListAction;
  readonly actedThreadKey: string;
  readonly selectedThreadKey: string | null;
}): boolean {
  return (
    input.actedThreadKey === input.selectedThreadKey &&
    (input.action === "archive" ||
      input.action === "delete" ||
      input.action === "settle" ||
      input.action === "snooze")
  );
}
