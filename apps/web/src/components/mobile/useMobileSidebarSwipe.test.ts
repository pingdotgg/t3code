import { describe, expect, it } from "vitest";

import {
  EDGE_TRIGGER_WIDTH,
  isSwipeIgnoredTarget,
  resolveSwipeAction,
} from "./useMobileSidebarSwipe";

describe("resolveSwipeAction", () => {
  it("returns 'open' on right-swipe from left edge", () => {
    expect(resolveSwipeAction(10, 300, 80, 302)).toBe("open");
  });

  it("returns null on right-swipe from non-edge start", () => {
    expect(resolveSwipeAction(100, 300, 170, 302)).toBeNull();
  });

  it("returns 'close' on left-swipe from anywhere", () => {
    expect(resolveSwipeAction(200, 300, 130, 302)).toBe("close");
  });

  it("returns null on vertical swipe (scroll)", () => {
    expect(resolveSwipeAction(10, 100, 20, 300)).toBeNull();
  });

  it("returns null on short horizontal swipe below threshold", () => {
    expect(resolveSwipeAction(10, 300, 40, 302)).toBeNull();
  });

  it("requires startX within EDGE_TRIGGER_WIDTH to open", () => {
    expect(resolveSwipeAction(EDGE_TRIGGER_WIDTH, 300, EDGE_TRIGGER_WIDTH + 70, 302)).toBeNull();
    expect(resolveSwipeAction(EDGE_TRIGGER_WIDTH - 1, 300, EDGE_TRIGGER_WIDTH + 69, 302)).toBe(
      "open",
    );
  });
});

describe("isSwipeIgnoredTarget", () => {
  it("returns false for null target", () => {
    expect(isSwipeIgnoredTarget(null)).toBe(false);
  });

  it("returns false for target without a closest method", () => {
    expect(isSwipeIgnoredTarget({} as EventTarget)).toBe(false);
  });

  it("returns true when closest finds a matching ancestor", () => {
    const target = {
      closest: (selector: string) =>
        selector === '[data-swipe-ignore="true"]' ? ({} as Element) : null,
    } as unknown as EventTarget;
    expect(isSwipeIgnoredTarget(target)).toBe(true);
  });

  it("returns false when closest finds nothing", () => {
    const target = { closest: () => null } as unknown as EventTarget;
    expect(isSwipeIgnoredTarget(target)).toBe(false);
  });
});
