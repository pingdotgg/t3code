import { describe, expect, it } from "vite-plus/test";

import { nativeHeaderScrollEdgeEffects, nativeTopScrollEdgeEffect } from "./scrollEdgeEffects";

describe("nativeTopScrollEdgeEffect", () => {
  it("keeps the automatic native treatment on iOS 26", () => {
    expect(nativeTopScrollEdgeEffect("ios", "26.5")).toBe("automatic");
  });

  it("keeps UIKit automatic scroll-edge sampling on iOS 27 and later", () => {
    expect(nativeTopScrollEdgeEffect("ios", "27.0")).toBe("automatic");
    expect(nativeTopScrollEdgeEffect("ios", 28)).toBe("automatic");
  });

  it("does not apply the iOS workaround to other platforms", () => {
    expect(nativeTopScrollEdgeEffect("android", 27)).toBe("automatic");
  });
});

describe("nativeHeaderScrollEdgeEffects", () => {
  it("keeps non-top header edges hidden while applying the platform top effect", () => {
    expect(nativeHeaderScrollEdgeEffects("ios", "27.0")).toEqual({
      top: "automatic",
      bottom: "hidden",
      left: "hidden",
      right: "hidden",
    });
  });
});
