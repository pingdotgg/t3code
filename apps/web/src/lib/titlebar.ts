/**
 * Geometry for the title-bar row shared by the sidebar chrome and every pane
 * header. Kept in one place so a header cannot drift off the row, or forget to
 * clear the Windows overlay controls, the way they did when each call site
 * spelled the classes out itself.
 */

/**
 * Height of the shared title-bar row.
 *
 * The row is window chrome sharing a line with the macOS traffic lights, which
 * macOS draws in screen points and page zoom does not scale. A plain `44px` row
 * grew with the zoom and dragged the whole line — lights, title, and actions —
 * down away from the window corner: at 150% it stood 66pt tall and pushed the
 * lights 28pt down, against Cursor's 9pt. Dividing by the zoom holds the row to
 * a constant height on screen instead, and the floor lets it grow rather than
 * clip once zoomed content needs more than that. `titleBarRowHeightForZoom()`
 * in the desktop main process mirrors this so the lights land on the same line.
 *
 * Because the height is fixed rather than intrinsic, the row also centres its
 * own content: a header that instead padded itself to the row's height would
 * overflow it and sit off the line the traffic lights are drawn on. Carrying
 * the centring here means a call site cannot forget it.
 */
export const TITLEBAR_ROW_CLASS =
  "flex items-center h-[max(28px,calc(var(--spacing-titlebar)/var(--app-zoom,1)))] wco:h-[env(titlebar-area-height)]";

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
 * zoomed CSS pixels, so their ratio is the page zoom factor.
 *
 * Only a fallback for a renderer without the desktop bridge: the two values do
 * not agree with each other until the window has settled, so at startup this
 * reads a default `outerWidth` against an already-final `innerWidth` and
 * reports a wildly wrong factor. Prefer `readAppZoomFactor()`.
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
 * What the zoom factor can be read from: the desktop bridge when the app is
 * running under Electron, and the window's own dimensions otherwise.
 */
export type AppZoomSource = Pick<Window, "outerWidth" | "innerWidth"> & {
  readonly desktopBridge?: { readonly getZoomFactor?: () => number } | undefined;
};

/**
 * The window's page-zoom factor.
 *
 * Chromium owns this value, so the desktop bridge reports it directly and it is
 * correct from the first paint. Deriving it from the window's own dimensions
 * instead made the title bar depend on startup timing: until the window settled
 * into its saved bounds, a default `outerWidth` divided by the final
 * `innerWidth` read as ~0.36, which inflated the row to roughly 100px and left
 * it towering over the traffic lights until the next zoom or resize corrected
 * it. The measurement stays only as a fallback for a renderer without the
 * bridge, where there is nothing better to go on.
 */
export function readAppZoomFactor(view: AppZoomSource): number {
  const bridgeZoomFactor = view.desktopBridge?.getZoomFactor?.();
  if (typeof bridgeZoomFactor === "number" && Number.isFinite(bridgeZoomFactor)) {
    if (bridgeZoomFactor > 0) {
      return bridgeZoomFactor;
    }
  }
  return readWindowZoomFactor(view);
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
      readAppZoomFactor(window).toFixed(4),
    );
  };

  update();
  window.addEventListener("resize", update);
  return () => {
    window.removeEventListener("resize", update);
  };
}
