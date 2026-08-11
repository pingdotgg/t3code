import { describe, expect, it } from "vitest";

import {
  TITLEBAR_ROW_HEIGHT,
  TRAFFIC_LIGHT_DIAMETER,
  TRAFFIC_LIGHT_INSET_X,
  trafficLightPositionForZoom,
} from "./titleBarGeometry.ts";
import { DEFAULT_ZOOM_FACTOR } from "./zoomLevels.ts";

describe("trafficLightPositionForZoom", () => {
  it("centres the controls on the unzoomed title-bar row", () => {
    expect(trafficLightPositionForZoom(DEFAULT_ZOOM_FACTOR)).toEqual({
      x: TRAFFIC_LIGHT_INSET_X,
      y: (TITLEBAR_ROW_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2,
    });
  });

  it("follows the row as page zoom grows it", () => {
    // Regression: the position was a constant, so a zoomed window left the
    // controls stranded near the top of a much taller row.
    expect(trafficLightPositionForZoom(1.5)).toEqual({ x: TRAFFIC_LIGHT_INSET_X, y: 27 });
    expect(trafficLightPositionForZoom(0.75)).toEqual({ x: TRAFFIC_LIGHT_INSET_X, y: 11 });
  });

  it.each([0.75, 1, 1.25, 1.5, 2, 3])(
    "pins the controls to the window corner at zoom %s",
    (zoomFactor) => {
      // Regression: the inset scaled with the zoom, so zooming in walked the
      // lights away from the corner instead of leaving them on it.
      expect(trafficLightPositionForZoom(zoomFactor).x).toBe(TRAFFIC_LIGHT_INSET_X);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the unzoomed position for %s",
    (zoomFactor) => {
      expect(trafficLightPositionForZoom(zoomFactor)).toEqual(
        trafficLightPositionForZoom(DEFAULT_ZOOM_FACTOR),
      );
    },
  );
});
