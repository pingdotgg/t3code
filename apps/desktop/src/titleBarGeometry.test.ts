import { describe, expect, it } from "vitest";

import {
  TITLEBAR_ROW_HEIGHT,
  TRAFFIC_LIGHT_DIAMETER,
  trafficLightPositionForZoom,
} from "./titleBarGeometry.ts";
import { DEFAULT_ZOOM_FACTOR } from "./zoomLevels.ts";

describe("trafficLightPositionForZoom", () => {
  it("centres the controls on the unzoomed title-bar row", () => {
    expect(trafficLightPositionForZoom(DEFAULT_ZOOM_FACTOR)).toEqual({
      x: 16,
      y: (TITLEBAR_ROW_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2,
    });
  });

  it("follows the row as page zoom grows it", () => {
    // Regression: the position was a constant, so a zoomed window left the
    // controls stranded near the top of a much taller row.
    expect(trafficLightPositionForZoom(1.5)).toEqual({ x: 24, y: 27 });
    expect(trafficLightPositionForZoom(0.75)).toEqual({ x: 12, y: 11 });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the unzoomed position for %s",
    (zoomFactor) => {
      expect(trafficLightPositionForZoom(zoomFactor)).toEqual(
        trafficLightPositionForZoom(DEFAULT_ZOOM_FACTOR),
      );
    },
  );
});
