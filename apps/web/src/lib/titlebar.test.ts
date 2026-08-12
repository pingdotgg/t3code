import { describe, expect, it } from "vitest";

import {
  readAppZoomFactor,
  readWindowZoomFactor,
  TITLEBAR_ROW_CLASS,
  TITLEBAR_TRAFFIC_LIGHT_INSET_CLASS,
} from "./titlebar";

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

describe("readAppZoomFactor", () => {
  it("takes the factor from the desktop bridge rather than the window's own size", () => {
    // Regression: the window's dimensions do not agree with each other until it
    // has settled into its saved bounds, so at startup a default `outerWidth`
    // divided by an already-final `innerWidth` read as ~0.36. The row divides
    // by this factor, so it inflated to ~100px and towered over the traffic
    // lights until a later zoom or resize happened to correct it.
    const startingUp = { outerWidth: 1067, innerWidth: 2990 };

    expect(readWindowZoomFactor(startingUp)).toBeCloseTo(0.357, 2);
    expect(readAppZoomFactor({ ...startingUp, desktopBridge: { getZoomFactor: () => 1 } })).toBe(1);
  });

  it("reports the real factor while the window is genuinely zoomed", () => {
    expect(
      readAppZoomFactor({
        outerWidth: 1600,
        innerWidth: 1600,
        desktopBridge: { getZoomFactor: () => 1.5 },
      }),
    ).toBe(1.5);
  });

  it.each([
    ["no bridge at all", undefined],
    ["a bridge without the method", {}],
    ["a nonsensical factor", { getZoomFactor: () => 0 }],
    ["a non-finite factor", { getZoomFactor: () => Number.NaN }],
  ])("falls back to the window measurement given %s", (_label, desktopBridge) => {
    expect(readAppZoomFactor({ outerWidth: 1200, innerWidth: 1600, desktopBridge })).toBeCloseTo(
      0.75,
      2,
    );
  });
});

describe("TITLEBAR_ROW_CLASS", () => {
  it("holds the row to a constant on-screen height with a floor for zoomed content", () => {
    // Regression: the row was a plain `h-titlebar`, so it grew with the page
    // zoom and dragged the traffic lights down away from the window corner.
    // `titleBarRowHeightForZoom()` in the desktop main process mirrors this
    // expression; the two must agree or the lights fall off the row.
    const match =
      /h-\[max\((\d+)px,calc\(var\(--spacing-titlebar\)\/var\(--app-zoom,1\)\)\)\]/.exec(
        TITLEBAR_ROW_CLASS,
      );
    expect(match).not.toBeNull();
    const [, floorCssPx = ""] = match ?? [];
    // Keep in sync with `TITLEBAR_ROW_MIN_CSS_HEIGHT` in the desktop package,
    // which a cross-package import cannot reach.
    expect(Number(floorCssPx)).toBe(28);
  });

  it("centres its own content on the row", () => {
    // Regression: the row is a fixed height rather than an intrinsic one, so a
    // header that padded itself to the old height instead of centring inside
    // it overflowed the row and sat below the line the traffic lights are
    // drawn on. Carrying the centring in the shared class is what stops a call
    // site from reintroducing that.
    expect(TITLEBAR_ROW_CLASS).toMatch(/(^|\s)flex(\s|$)/);
    expect(TITLEBAR_ROW_CLASS).toMatch(/(^|\s)items-center(\s|$)/);
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
