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

/**
 * Left inset that clears the macOS traffic lights (or the Windows overlay
 * controls) so the leading header content starts just after them.
 *
 * macOS draws the traffic lights in screen points at a fixed 12pt diameter and
 * 20pt pitch, and Chromium's page zoom does not scale them. Main pins the first
 * one 10pt from the window edge, so three of them end 62pt in (`10 + 2 * 20 +
 * 12`); a 12pt gap after the last one puts the content at 74pt. Dividing by the
 * zoom converts that to the renderer's zoomed CSS pixels, so the gap stays the
 * same on screen at every zoom level instead of widening with it.
 */
export const TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS =
  "pl-[calc(74px/var(--app-zoom,1))] wco:pl-[calc(env(titlebar-area-x)+1em)]";

/** CSS custom property holding the window's current page-zoom factor. */
export const APP_ZOOM_CSS_VARIABLE = "--app-zoom";

/**
 * `outerWidth` is measured in screen points and `innerWidth` in the renderer's
 * zoomed CSS pixels, so their ratio is the page zoom factor. Reading it here
 * avoids a main-process round trip for a value the renderer already has.
 */
export function readWindowZoomFactor(view: Pick<Window, "outerWidth" | "innerWidth">): number {
  const { outerWidth, innerWidth } = view;
  if (!Number.isFinite(outerWidth) || !Number.isFinite(innerWidth) || innerWidth <= 0) {
    return 1;
  }
  const zoomFactor = outerWidth / innerWidth;
  // Anything outside Chromium's zoom range means the window is mid-transition
  // (minimised, restoring) rather than genuinely zoomed.
  return zoomFactor >= 0.25 && zoomFactor <= 5 ? zoomFactor : 1;
}

/**
 * Publishes the zoom factor as a CSS variable and keeps it current. `resize`
 * fires on every zoom change because zooming changes `innerWidth`.
 */
export function syncDocumentAppZoomVariable(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const update = () => {
    document.documentElement.style.setProperty(
      APP_ZOOM_CSS_VARIABLE,
      readWindowZoomFactor(window).toFixed(4),
    );
  };

  update();
  window.addEventListener("resize", update);
  return () => {
    window.removeEventListener("resize", update);
  };
}
