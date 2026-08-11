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
    // Regression: the inset used to resolve to `28 * zoom + 52` points while
    // the controls ended at `16 * zoom + 52`, so the gap grew as `12 * zoom`.
    const match = /calc\((\d+)px\+(\d+)px\/var\(--app-zoom,1\)\)/.exec(
      TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS,
    );
    expect(match).not.toBeNull();
    const [, constantPx = "", scaledPx = ""] = match ?? [];

    for (const zoomFactor of [0.75, 1, 1.5, 2, 3]) {
      // The renderer lays the inset out in zoomed CSS pixels; multiplying by
      // the zoom factor converts it to the screen points the controls live in.
      const insetPoints = (Number(constantPx) + Number(scaledPx) / zoomFactor) * zoomFactor;
      // Main places the first control at `16 * zoom`; three controls at a 20pt
      // pitch and 12pt diameter span a further 52pt.
      const controlsEndPoints = 16 * zoomFactor + 52;
      expect(insetPoints - controlsEndPoints).toBeCloseTo(12, 6);
    }
  });
});
