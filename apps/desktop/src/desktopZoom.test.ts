import { describe, expect, it } from "vitest";

import { normalizeDesktopZoomFactor, resolveDesktopZoomCssVariables } from "./desktopZoom.ts";

describe("desktopZoom", () => {
  it("gradually reduces zoomed-out titlebar leading spacing", () => {
    expect(resolveDesktopZoomCssVariables(0.8)).toEqual({
      titlebarHeight: "65px",
      titlebarLeadingOffset: "106.5px",
    });
    expect(resolveDesktopZoomCssVariables(0.6)).toEqual({
      titlebarHeight: "86.66666666666667px",
      titlebarLeadingOffset: "136.66666666666669px",
    });
  });

  it("keeps a minimum leading offset clear of the traffic lights", () => {
    expect(resolveDesktopZoomCssVariables(0.4)).toEqual({
      titlebarHeight: "130px",
      titlebarLeadingOffset: "205px",
    });
  });

  it("compensates titlebar spacing when zoomed in", () => {
    expect(resolveDesktopZoomCssVariables(1.25)).toEqual({
      titlebarHeight: "41.6px",
      titlebarLeadingOffset: "72px",
    });
  });

  it("normalizes invalid zoom factors", () => {
    expect(normalizeDesktopZoomFactor(0)).toBe(1);
    expect(normalizeDesktopZoomFactor(Number.NaN)).toBe(1);
    expect(resolveDesktopZoomCssVariables(0)).toEqual({
      titlebarHeight: "52px",
      titlebarLeadingOffset: "90px",
    });
  });
});
