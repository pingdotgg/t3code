import { describe, expect, it } from "vite-plus/test";

import { rectanglesIntersect, shouldPresentNativeSurface } from "./nativeSurfaceOcclusion";

describe("nativeSurfaceOcclusion", () => {
  const surface = { left: 100, top: 200, right: 900, bottom: 700 };

  it("detects an app overlay crossing the native browser surface", () => {
    expect(rectanglesIntersect(surface, { left: 400, top: 150, right: 650, bottom: 260 })).toBe(
      true,
    );
  });

  it("does not occlude for toolbar-only overlays or touching edges", () => {
    expect(rectanglesIntersect(surface, { left: 400, top: 100, right: 650, bottom: 190 })).toBe(
      false,
    );
    expect(rectanglesIntersect(surface, { left: 400, top: 100, right: 650, bottom: 200 })).toBe(
      false,
    );
  });

  it("keeps the native surface live until an occlusion frame is ready", () => {
    expect(shouldPresentNativeSurface(true, true, false)).toBe(true);
    expect(shouldPresentNativeSurface(true, true, true)).toBe(false);
    expect(shouldPresentNativeSurface(true, false, true)).toBe(true);
    expect(shouldPresentNativeSurface(false, true, false)).toBe(false);
  });
});
