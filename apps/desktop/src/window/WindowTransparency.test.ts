import { describe, expect, it } from "vite-plus/test";

import {
  clampWindowOpacity,
  markCreatedTransparent,
  nativeWindowOpacity,
  resolveWindowTransparencyMode,
  shouldCreateTransparentWindow,
  wasCreatedTransparent,
} from "./WindowTransparency.ts";

describe("WindowTransparency", () => {
  it("keeps stored opacity readable and within range", () => {
    expect(clampWindowOpacity(undefined)).toBe(100);
    expect(clampWindowOpacity(Number.NaN)).toBe(100);
    expect(clampWindowOpacity(5)).toBe(30);
    expect(clampWindowOpacity(250)).toBe(100);
    expect(clampWindowOpacity(72.4)).toBe(72);
    expect(nativeWindowOpacity(55)).toBe(0.55);
  });

  it("creates a transparent window on Linux, where the renderer fades its own surfaces", () => {
    expect(shouldCreateTransparentWindow("linux")).toBe(true);
    expect(shouldCreateTransparentWindow("win32")).toBe(false);
    expect(shouldCreateTransparentWindow("darwin")).toBe(false);
  });

  it("tells the renderer who fades the window", () => {
    expect(resolveWindowTransparencyMode({ platform: "win32", createdTransparent: false })).toBe(
      "native",
    );
    expect(resolveWindowTransparencyMode({ platform: "darwin", createdTransparent: false })).toBe(
      "native",
    );
    expect(resolveWindowTransparencyMode({ platform: "linux", createdTransparent: true })).toBe(
      "compositor",
    );
    expect(resolveWindowTransparencyMode({ platform: "linux", createdTransparent: false })).toBe(
      "restart-required",
    );
  });

  it("remembers which windows were created transparent", () => {
    const transparent = {};
    const opaque = {};
    markCreatedTransparent(transparent);
    expect(wasCreatedTransparent(transparent)).toBe(true);
    expect(wasCreatedTransparent(opaque)).toBe(false);
  });
});
