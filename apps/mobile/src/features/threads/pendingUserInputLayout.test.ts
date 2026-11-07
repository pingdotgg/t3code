import { describe, expect, it } from "vite-plus/test";

import { deriveRevealScrollOffset } from "./pendingUserInputLayout";

describe("deriveRevealScrollOffset", () => {
  it("keeps the offset when the child is fully visible", () => {
    expect(
      deriveRevealScrollOffset({ top: 100, height: 54, viewportHeight: 300, offset: 0 }),
    ).toBeNull();
  });

  it("scrolls down only until the child's bottom edge is visible", () => {
    expect(deriveRevealScrollOffset({ top: 400, height: 54, viewportHeight: 200, offset: 0 })).toBe(
      254,
    );
  });

  it("scrolls up to the child's top edge when it is above the viewport", () => {
    expect(
      deriveRevealScrollOffset({ top: 120, height: 54, viewportHeight: 200, offset: 150 }),
    ).toBe(120);
  });

  it("aligns a child taller than the viewport to its top edge", () => {
    expect(
      deriveRevealScrollOffset({ top: 400, height: 300, viewportHeight: 200, offset: 0 }),
    ).toBe(400);
  });
});
