import { describe, expect, it } from "vite-plus/test";

import {
  applyThemeBackdrop,
  computeDaylight,
  getActiveThemeBackdrop,
  packGlyphBits,
  subscribeThemeBackdrop,
} from "./themeBackdrop";

describe("themeBackdrop", () => {
  it("computes smooth 0..1 daylight across the 24-hour cycle", () => {
    const midnight = new Date(2026, 0, 1, 0, 0).getTime();
    const dawn = new Date(2026, 0, 1, 6, 0).getTime();
    const noon = new Date(2026, 0, 1, 12, 0).getTime();
    const dusk = new Date(2026, 0, 1, 18, 0).getTime();

    expect(computeDaylight(midnight)).toBe(0);
    expect(computeDaylight(noon)).toBe(1);
    expect(computeDaylight(dawn)).toBeCloseTo(0.5, 5);
    expect(computeDaylight(dusk)).toBeCloseTo(0.5, 5);
  });

  it("packs 3x5 bitmap glyph strings into bitmasks", () => {
    expect(packGlyphBits("...|...|...|...|...")).toBe(0);
    expect(packGlyphBits("#..|...|...|...|...")).toBe(1);
    expect(packGlyphBits("...|...|...|...|.#.")).toBe(1 << 13);
  });

  it("tracks active GLSL and WGSL backdrop state and notifies subscribers", () => {
    let calls = 0;
    const unsubscribe = subscribeThemeBackdrop(() => {
      calls += 1;
    });
    try {
      applyThemeBackdrop({
        glsl: "#version 300 es\nout vec4 c; void main(){c=vec4(0.0);}",
        fps: 24,
      });
      expect(getActiveThemeBackdrop()?.fps).toBe(24);
      expect(calls).toBe(1);

      applyThemeBackdrop({
        wgsl: "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0); }",
        hdr: true,
        hdrPeak: 3,
      });
      expect(getActiveThemeBackdrop()?.hdr).toBe(true);
      expect(calls).toBe(2);

      applyThemeBackdrop(undefined);
      expect(getActiveThemeBackdrop()).toBeNull();
      expect(calls).toBe(3);
    } finally {
      unsubscribe();
      applyThemeBackdrop(undefined);
    }
  });
});
