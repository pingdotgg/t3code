import { describe, expect, it } from "vitest";

import { readWindowZoomFactor, TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS } from "./titlebar";

describe("readWindowZoomFactor", () => {
  it("derives the zoom factor from the screen-point to CSS-pixel ratio", () => {
    expect(readWindowZoomFactor({ outerWidth: 1600, innerWidth: 1600 })).toBe(1);
    expect(readWindowZoomFactor({ outerWidth: 1600, innerWidth: 1067 })).toBeCloseTo(1.5, 2);
    expect(readWindowZoomFactor({ outerWidth: 1200, innerWidth: 1600 })).toBeCloseTo(0.75, 2);
  });

  it.each([
    ["a minimised window", { outerWidth: 1600, innerWidth: 0 }],
    ["an out-of-range ratio", { outerWidth: 1600, innerWidth: 100 }],
    ["a non-finite measurement", { outerWidth: Number.NaN, innerWidth: 1600 }],
  ])("falls back to 1 for %s", (_label, view) => {
    expect(readWindowZoomFactor(view)).toBe(1);
  });
});

describe("TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS", () => {
  it("keeps a constant screen-space gap after the traffic lights at every zoom", () => {
    // Regression: the inset used to carry a zoom-invariant term to match a
    // first control placed at `16 * zoom`. Both now sit at a constant screen
    // offset, so the whole inset scales as `1 / zoom`.
    const match = /calc\((\d+)px\/var\(--app-zoom,1\)\)/.exec(TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS);
    expect(match).not.toBeNull();
    const [, scaledPx = ""] = match ?? [];

    for (const zoomFactor of [0.75, 1, 1.5, 2, 3]) {
      // The renderer lays the inset out in zoomed CSS pixels; multiplying by
      // the zoom factor converts it to the screen points the controls live in.
      const insetPoints = (Number(scaledPx) / zoomFactor) * zoomFactor;
      // Main pins the first control 10pt in; three controls at a 20pt pitch
      // and 12pt diameter span a further 52pt, at any zoom.
      const controlsEndPoints = 10 + 52;
      expect(insetPoints - controlsEndPoints).toBeCloseTo(12, 6);
    }
  });
});
