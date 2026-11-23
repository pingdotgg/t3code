import { describe, expect, it } from "vite-plus/test";

import {
  applyThemeBackdrop,
  computeDaylight,
  getActiveThemeBackdrop,
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

  it("tracks active GLSL backdrop state and notifies subscribers on change", () => {
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

      applyThemeBackdrop(undefined);
      expect(getActiveThemeBackdrop()).toBeNull();
      expect(calls).toBe(2);
    } finally {
      unsubscribe();
      applyThemeBackdrop(undefined);
    }
  });
});
