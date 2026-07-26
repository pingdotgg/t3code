import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TRANSLUCENCY, coverage } from "./glass.ts";
import { themeCssVariables } from "./applyTheme.ts";

describe("themeCssVariables", () => {
  it("publishes the layer alphas the stylesheet reads", () => {
    const variables = themeCssVariables({
      translucency: DEFAULT_TRANSLUCENCY,
      reduceMotion: false,
    });
    expect(variables).toHaveProperty("--plate-alpha");
    expect(variables).toHaveProperty("--wash-alpha");
    expect(variables).toHaveProperty("--photo-opacity");
    // Below PLATE_START the plate must stay at zero, or the window silently
    // stops being translucent.
    expect(variables["--plate-alpha"]).toBe("0");
  });

  it("keeps the honesty invariant after the round trip through strings", () => {
    for (const translucency of [0.5, 0.7, 0.85, 1]) {
      const variables = themeCssVariables({ translucency, reduceMotion: false });
      const wash = Number(variables["--wash-alpha"]);
      const photo = Number(variables["--photo-opacity"]);
      expect(coverage(photo, wash)).toBeCloseTo(translucency, 4);
    }
  });

  it("carries the reduce-motion decision into the decorative gate", () => {
    expect(
      themeCssVariables({ translucency: 0.85, reduceMotion: true })["--motion-decorative-opacity"],
    ).toBe("0");
    expect(
      themeCssVariables({ translucency: 0.85, reduceMotion: false })["--motion-decorative-opacity"],
    ).toBe("1");
  });

  it("emits palette and typography tokens as valid CSS values", () => {
    const variables = themeCssVariables({ translucency: 0.85, reduceMotion: false });
    expect(variables["--color-accent"]).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
    expect(variables["--color-user-bubble-stroke"]).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.22\)$/);
    expect(variables["--font-chat-body"]).toContain("Geist");
  });
});
