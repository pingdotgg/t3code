/**
 * macOS draws the traffic lights itself, in screen points, and Chromium's page
 * zoom does not scale them. The renderer's title-bar row does scale, so a fixed
 * button position drifts off the row — and away from the sidebar's collapse
 * trigger — the moment the window is zoomed. Deriving the position from the
 * zoom factor keeps the controls centred on the row at any zoom.
 */

import { DEFAULT_ZOOM_FACTOR } from "./zoomLevels.ts";

/** Height of the renderer's title-bar row. Keep in sync with `--spacing-titlebar`. */
export const TITLEBAR_ROW_HEIGHT = 44;

/** Diameter macOS uses for a traffic light, in screen points. */
export const TRAFFIC_LIGHT_DIAMETER = 12;

/** Left inset of the first traffic light, in the renderer's own CSS pixels. */
export const TRAFFIC_LIGHT_INSET_X = 16;

export function trafficLightPositionForZoom(zoomFactor: number): { x: number; y: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : DEFAULT_ZOOM_FACTOR;
  return {
    x: Math.round(TRAFFIC_LIGHT_INSET_X * zoom),
    y: Math.round((TITLEBAR_ROW_HEIGHT * zoom - TRAFFIC_LIGHT_DIAMETER) / 2),
  };
}
