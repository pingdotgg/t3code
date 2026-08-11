/**
 * macOS draws the traffic lights itself, in screen points, and Chromium's page
 * zoom does not scale them. The renderer's title-bar row does scale, so a fixed
 * vertical position leaves the buttons stranded near the top of a much taller
 * row the moment the window is zoomed. Deriving the position from the zoom
 * factor keeps them centred on the row at any zoom.
 */

import { DEFAULT_ZOOM_FACTOR } from "./zoomLevels.ts";

/** Height of the renderer's title-bar row. Keep in sync with `--spacing-titlebar`. */
export const TITLEBAR_ROW_HEIGHT = 44;

/** Diameter macOS uses for a traffic light, in screen points. */
export const TRAFFIC_LIGHT_DIAMETER = 12;

/**
 * Left inset of the first traffic light, in screen points.
 *
 * The lights are window chrome rather than page content, so this stays a
 * constant: scaling it with page zoom walked them away from the window corner
 * — at 133% zoom a 16pt inset rendered as 21pt — and wasted the leading space
 * in the row. A constant inset pins them to the corner at every zoom.
 */
export const TRAFFIC_LIGHT_INSET_X = 10;

export function trafficLightPositionForZoom(zoomFactor: number): { x: number; y: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : DEFAULT_ZOOM_FACTOR;
  return {
    x: TRAFFIC_LIGHT_INSET_X,
    // Only the row is page content, so only the centring follows the zoom.
    y: Math.round((TITLEBAR_ROW_HEIGHT * zoom - TRAFFIC_LIGHT_DIAMETER) / 2),
  };
}
