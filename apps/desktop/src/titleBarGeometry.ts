/**
 * macOS draws the traffic lights itself, in screen points, at a fixed 12pt
 * diameter that Chromium's page zoom does not scale. Everything else on the
 * title-bar row is page content that does scale, so the row's on-screen height
 * — and with it the line the lights have to sit on — depends on the zoom.
 *
 * The renderer therefore holds the row to a constant on-screen height until the
 * zoomed content needs more room, and this module mirrors that same rule so the
 * main process can place the lights on the row the renderer will actually draw.
 */

import { DEFAULT_ZOOM_FACTOR } from "./zoomLevels.ts";

/**
 * On-screen height of the title-bar row, in screen points.
 *
 * Kept just tall enough to clear the 12pt traffic lights and a 24px control.
 * Keep in sync with `--spacing-titlebar` in `apps/web/src/index.css`.
 */
export const TITLEBAR_ROW_HEIGHT = 36;

/**
 * Floor on the row's height in the renderer's own CSS pixels.
 *
 * Zoomed page content outgrows a constant on-screen height, so the row has to
 * be able to grow with it rather than clip a control. Keep in sync with the
 * floor in `TITLEBAR_ROW_CLASS`.
 */
export const TITLEBAR_ROW_MIN_CSS_HEIGHT = 28;

/** Diameter macOS uses for a traffic light, in screen points. */
export const TRAFFIC_LIGHT_DIAMETER = 12;

/**
 * Left inset of the first traffic light, in screen points.
 *
 * The lights are window chrome rather than page content, so this stays a
 * constant: scaling it with page zoom walked them away from the window corner
 * and wasted the leading space in the row.
 */
export const TRAFFIC_LIGHT_INSET_X = 10;

/** On-screen height of the title-bar row at a given page zoom, in screen points. */
export function titleBarRowHeightForZoom(zoomFactor: number): number {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : DEFAULT_ZOOM_FACTOR;
  return Math.max(TITLEBAR_ROW_MIN_CSS_HEIGHT * zoom, TITLEBAR_ROW_HEIGHT);
}

export function trafficLightPositionForZoom(zoomFactor: number): { x: number; y: number } {
  return {
    x: TRAFFIC_LIGHT_INSET_X,
    y: Math.round((titleBarRowHeightForZoom(zoomFactor) - TRAFFIC_LIGHT_DIAMETER) / 2),
  };
}
