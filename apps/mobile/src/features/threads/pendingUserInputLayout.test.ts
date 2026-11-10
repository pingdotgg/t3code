import { describe, expect, it } from "vite-plus/test";

import {
  derivePendingUserInputMaxHeight,
  deriveRevealScrollOffset,
} from "./pendingUserInputLayout";

describe("derivePendingUserInputMaxHeight", () => {
  it("gives a closed-keyboard card all the room between the header and the composer", () => {
    expect(
      derivePendingUserInputMaxHeight({
        windowHeight: 874,
        keyboardHeight: 0,
        navigationHeaderHeight: 116,
        composerOverlapHeight: 90,
      }),
    ).toBe(656);
  });
});

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

  it("aligns a child taller than the viewport to its top edge when none of it is visible", () => {
    expect(
      deriveRevealScrollOffset({ top: 400, height: 300, viewportHeight: 200, offset: 0 }),
    ).toBe(400);
  });

  it("keeps the offset when a child taller than the viewport already overlaps it", () => {
    expect(
      deriveRevealScrollOffset({ top: 40, height: 600, viewportHeight: 263, offset: 300 }),
    ).toBeNull();
    expect(
      deriveRevealScrollOffset({ top: 0, height: 300, viewportHeight: 263, offset: 37 }),
    ).toBeNull();
  });
});
