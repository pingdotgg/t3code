import { describe, expect, it } from "vite-plus/test";

import { computeDaylight, NIMBUS_FRAGMENT_SHADER } from "./themeBackdrop";

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

  it("includes the Nimbus GLSL ES 3.00 fragment shader uniforms", () => {
    expect(NIMBUS_FRAGMENT_SHADER).toContain("#version 300 es");
    expect(NIMBUS_FRAGMENT_SHADER).toContain("uniform float u_time;");
    expect(NIMBUS_FRAGMENT_SHADER).toContain("uniform vec2 u_resolution;");
    expect(NIMBUS_FRAGMENT_SHADER).toContain("uniform float u_daylight;");
  });
});
