import { describe, expect, it } from "vitest";

import {
  TITLEBAR_ROW_HEIGHT,
  TITLEBAR_ROW_MIN_CSS_HEIGHT,
  TRAFFIC_LIGHT_DIAMETER,
  TRAFFIC_LIGHT_INSET_X,
  titleBarRowHeightForZoom,
  trafficLightPositionForZoom,
} from "./titleBarGeometry.ts";
import { DEFAULT_ZOOM_FACTOR } from "./zoomLevels.ts";

describe("titleBarRowHeightForZoom", () => {
  it("holds the row to a constant on-screen height while the content fits", () => {
    // Regression: the row was plain page content, so it grew with the zoom and
    // dragged the traffic lights down away from the window corner.
    for (const zoomFactor of [0.5, 0.75, 1, 1.25]) {
      expect(titleBarRowHeightForZoom(zoomFactor)).toBe(TITLEBAR_ROW_HEIGHT);
    }
  });

  it("grows once zoomed content needs more room than that", () => {
    // A 24px control at 200% is 48pt tall and has to fit rather than clip.
    expect(titleBarRowHeightForZoom(2)).toBe(TITLEBAR_ROW_MIN_CSS_HEIGHT * 2);
    expect(titleBarRowHeightForZoom(3)).toBe(TITLEBAR_ROW_MIN_CSS_HEIGHT * 3);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the unzoomed height for %s",
    (zoomFactor) => {
      expect(titleBarRowHeightForZoom(zoomFactor)).toBe(
        titleBarRowHeightForZoom(DEFAULT_ZOOM_FACTOR),
      );
    },
  );
});

describe("trafficLightPositionForZoom", () => {
  it("centres the controls on the unzoomed title-bar row", () => {
    expect(trafficLightPositionForZoom(DEFAULT_ZOOM_FACTOR)).toEqual({
      x: TRAFFIC_LIGHT_INSET_X,
      y: (TITLEBAR_ROW_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2,
    });
  });

  it.each([0.75, 1, 1.25, 1.5, 2, 3])(
    "pins the controls to the window corner at zoom %s",
    (zoomFactor) => {
      // Regression: the inset scaled with the zoom, so zooming in walked the
      // lights away from the corner instead of leaving them on it.
      expect(trafficLightPositionForZoom(zoomFactor).x).toBe(TRAFFIC_LIGHT_INSET_X);
    },
  );

  it.each([0.75, 1, 1.25, 1.5, 2, 3])(
    "centres the controls on the row at zoom %s",
    (zoomFactor) => {
      const { y } = trafficLightPositionForZoom(zoomFactor);
      const rowHeight = titleBarRowHeightForZoom(zoomFactor);
      // Equal gap above and below, so the lights share the row's centre line with
      // the title and the header actions.
      expect(y).toBeCloseTo(rowHeight - TRAFFIC_LIGHT_DIAMETER - y, 0);
    },
  );

  it("keeps the controls near the corner as the window zooms in", () => {
    // Regression: at 150% the row stood 66pt tall and pushed the lights 27pt
    // down, nowhere near the corner they sit in at 100%.
    expect(trafficLightPositionForZoom(1.5).y).toBe(15);
    expect(trafficLightPositionForZoom(1).y).toBe(12);
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
