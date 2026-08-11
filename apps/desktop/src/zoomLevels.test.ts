import { describe, expect, it } from "vitest";

import { DEFAULT_ZOOM_FACTOR, nextZoomLevel, ZOOM_LEVELS } from "./zoomLevels.ts";

describe("nextZoomLevel", () => {
  it("walks the standard zoom ladder in both directions", () => {
    expect(nextZoomLevel(1, "in")).toBe(1.1);
    expect(nextZoomLevel(1, "out")).toBe(0.9);
    expect(nextZoomLevel(1.5, "in")).toBe(1.75);
    expect(nextZoomLevel(1.5, "out")).toBe(1.25);
  });

  it("snaps an off-ladder factor onto the neighbouring step in the travel direction", () => {
    // Regression: the preview copy of this ladder skipped past 1.1 on the way
    // down from 1.2, landing on 1.0.
    expect(nextZoomLevel(1.2, "in")).toBe(1.25);
    expect(nextZoomLevel(1.2, "out")).toBe(1.1);
  });

  it("clamps at the ends of the ladder", () => {
    expect(nextZoomLevel(5, "in")).toBe(5);
    expect(nextZoomLevel(0.25, "out")).toBe(0.25);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats %s as the default zoom factor",
    (zoomFactor) => {
      expect(nextZoomLevel(zoomFactor, "in")).toBe(nextZoomLevel(DEFAULT_ZOOM_FACTOR, "in"));
    },
  );

  it("keeps the default zoom factor on the ladder", () => {
    expect(ZOOM_LEVELS).toContain(DEFAULT_ZOOM_FACTOR);
  });
});
