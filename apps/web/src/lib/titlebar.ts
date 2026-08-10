/**
 * Geometry for the title-bar row shared by the sidebar chrome and every pane
 * header. Kept in one place so a header cannot drift off the row, or forget to
 * clear the Windows overlay controls, the way they did when each call site
 * spelled the classes out itself.
 */

/**
 * Height of the shared title-bar row. Falls back to the native overlay height
 * under Windows' controls overlay, which dictates its own row.
 */
export const TITLEBAR_ROW_CLASS = "h-titlebar wco:h-[env(titlebar-area-height)]";

/**
 * Right inset that keeps trailing header content clear of the Windows overlay
 * controls. Only correct for a header that reaches the window's right edge, so
 * call sites that can be covered by a right-hand panel gate it.
 */
export const TITLEBAR_CONTROL_INSET_CLASS =
  "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]";
