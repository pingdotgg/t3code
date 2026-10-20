import { describe, expect, it } from "vite-plus/test";

import { nativeTopScrollEdgeEffect } from "./scrollEdgeEffects";

describe("nativeTopScrollEdgeEffect", () => {
  it("keeps UIKit content sampling instead of a local soft overlay on iOS 27", () => {
    expect(nativeTopScrollEdgeEffect("ios", "27.0")).toBe("automatic");
  });
});
