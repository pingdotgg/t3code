import { describe, expect, it } from "vite-plus/test";

import { nativeTopScrollEdgeEffect } from "./native-scroll-edge-effect";

describe("nativeTopScrollEdgeEffect", () => {
  it("keeps the automatic native treatment on iOS 26", () => {
    expect(nativeTopScrollEdgeEffect("ios", "26.5")).toBe("automatic");
  });

  it("uses the native hard treatment on iOS 27 and later", () => {
    expect(nativeTopScrollEdgeEffect("ios", "27.0")).toBe("hard");
    expect(nativeTopScrollEdgeEffect("ios", 28)).toBe("hard");
  });

  it("does not apply the iOS workaround to other platforms", () => {
    expect(nativeTopScrollEdgeEffect("android", 27)).toBe("automatic");
  });
});
