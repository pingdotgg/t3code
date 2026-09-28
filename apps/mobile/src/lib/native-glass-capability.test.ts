import { describe, expect, it } from "vite-plus/test";

import { supportsNativeLiquidGlass } from "./native-glass-capability";

describe("supportsNativeLiquidGlass", () => {
  it("does not enable iOS liquid-glass layout behavior on other platforms", () => {
    expect(supportsNativeLiquidGlass("android", true)).toBe(false);
    expect(supportsNativeLiquidGlass("web", true)).toBe(false);
  });
});
