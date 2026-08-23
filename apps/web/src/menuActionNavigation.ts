// Menu actions arrive from the Electron main process as a plain string on one
// channel. Most are commands ("open-settings"); a deep link
// (t3code://threads/<environmentId>/<threadId>) arrives already resolved to a
// renderer path, because the main process is where the URL is parsed and the
// router is only reachable from here.
//
// Kept out of the component so the rule is testable without rendering, and so
// the component keeps a single call instead of a block of validation.

// Mirrors NAVIGATE_ACTION_PREFIX in apps/desktop/src/app/DesktopUrlRouting.ts.
// Duplicated rather than imported: the renderer bundle must not depend on the
// Electron main process sources.
export const MENU_ACTION_NAVIGATE_PREFIX = "navigate:";

/**
 * The path a menu action asks the router to go to, or `null` for anything else.
 *
 * `null` covers three separate cases on purpose, all of which mean "do not
 * navigate": the action is not a navigation at all, the target is not something
 * this app may route to, or it is where we already are.
 *
 * The target is treated as INPUT even though it comes from our own main
 * process, because it began life as a URL handed to the app by the operating
 * system. Only absolute in-app paths are accepted, and a protocol-relative
 * `//host` is rejected explicitly: the router would treat it as a path while a
 * browser would read it as another origin, and that difference is exactly where
 * an open redirect lives.
 */
export function resolveMenuActionNavigation(action: string, pathname: string): string | null {
  if (!action.startsWith(MENU_ACTION_NAVIGATE_PREFIX)) {
    return null;
  }
  const target = action.slice(MENU_ACTION_NAVIGATE_PREFIX.length);
  if (!target.startsWith("/") || target.startsWith("//")) {
    return null;
  }
  if (target === pathname) {
    return null;
  }
  return target;
}
