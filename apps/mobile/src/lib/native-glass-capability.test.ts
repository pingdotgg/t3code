import { describe, expect, it } from "vite-plus/test";

import { supportsNativeLiquidGlass } from "./native-glass-capability";

describe("supportsNativeLiquidGlass", () => {
  it("uses native liquid glass when iOS reports the capability", () => {
    expect(supportsNativeLiquidGlass("ios", true)).toBe(true);
  });

  it("keeps pre-glass iOS on the solid fallback", () => {
    expect(supportsNativeLiquidGlass("ios", false)).toBe(false);
  });

  it("does not enable iOS liquid-glass layout behavior on other platforms", () => {
    expect(supportsNativeLiquidGlass("android", true)).toBe(false);
    expect(supportsNativeLiquidGlass("web", true)).toBe(false);
  });
});
