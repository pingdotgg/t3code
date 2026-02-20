import { describe, expect, it } from "vitest";

import { AUTO_SCROLL_BOTTOM_EPSILON_PX, isScrollContainerAtBottom } from "./chat-scroll";

describe("isScrollContainerAtBottom", () => {
  it("returns true when already at bottom", () => {
    expect(
      isScrollContainerAtBottom({
        scrollTop: 600,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns true when within the bottom epsilon", () => {
    expect(
      isScrollContainerAtBottom({
        scrollTop: 599,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns false when the user is above the epsilon", () => {
    expect(
      isScrollContainerAtBottom({
        scrollTop: 597,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(false);
  });

  it("clamps negative epsilons to zero", () => {
    expect(
      isScrollContainerAtBottom(
        {
          scrollTop: 599,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        -1,
      ),
    ).toBe(false);
  });

  it("falls back to the default epsilon for non-finite values", () => {
    expect(
      isScrollContainerAtBottom(
        {
          scrollTop: 599,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        Number.NaN,
      ),
    ).toBe(true);
    expect(AUTO_SCROLL_BOTTOM_EPSILON_PX).toBe(2);
  });

  it("treats overscrolled values as bottom", () => {
    expect(
      isScrollContainerAtBottom({
        scrollTop: 610,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });
});
