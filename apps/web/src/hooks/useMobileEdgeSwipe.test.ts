import { describe, expect, it } from "vitest";

import {
  hasActiveTextSelection,
  isMobileEdgeSwipeStart,
  MOBILE_EDGE_SWIPE_OPEN_INTENT_TIMEOUT_MS,
  resolveHorizontalScrollOwnerSwipeDecision,
  resolveMobileEdgeSwipeDecision,
} from "./useMobileEdgeSwipe";

describe("resolveMobileEdgeSwipeDecision", () => {
  it("opens the left panel after a horizontal rightward edge swipe", () => {
    expect(resolveMobileEdgeSwipeDecision({ deltaX: 64, deltaY: 12, side: "left" })).toBe("open");
  });

  it("opens the right panel after a horizontal leftward edge swipe", () => {
    expect(resolveMobileEdgeSwipeDecision({ deltaX: -64, deltaY: 12, side: "right" })).toBe("open");
  });

  it("closes the left panel after a horizontal leftward swipe", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        action: "close",
        deltaX: -64,
        deltaY: 12,
        side: "left",
      }),
    ).toBe("close");
  });

  it("closes the right panel after a horizontal rightward swipe", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        action: "close",
        deltaX: 64,
        deltaY: 12,
        side: "right",
      }),
    ).toBe("close");
  });

  it("keeps short horizontal movement pending", () => {
    expect(resolveMobileEdgeSwipeDecision({ deltaX: 32, deltaY: 4, side: "left" })).toBe("pending");
  });

  it("opens from a quick screen-wide swipe", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        deltaX: 64,
        deltaY: 12,
        elapsedMs: MOBILE_EDGE_SWIPE_OPEN_INTENT_TIMEOUT_MS,
        side: "left",
      }),
    ).toBe("open");
  });

  it("cancels slow open gestures that look like text selection drags", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        deltaX: 64,
        deltaY: 12,
        elapsedMs: MOBILE_EDGE_SWIPE_OPEN_INTENT_TIMEOUT_MS + 1,
        side: "left",
      }),
    ).toBe("cancel");
  });

  it("does not apply the open-intent timeout to close gestures", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        action: "close",
        deltaX: -64,
        deltaY: 12,
        elapsedMs: MOBILE_EDGE_SWIPE_OPEN_INTENT_TIMEOUT_MS + 1,
        side: "left",
      }),
    ).toBe("close");
  });

  it("cancels vertical scrolling so it does not open a panel", () => {
    expect(resolveMobileEdgeSwipeDecision({ deltaX: 18, deltaY: 40, side: "left" })).toBe("cancel");
  });

  it("opens the right panel on a quick horizontally dominant flick before the sustained distance", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        deltaX: -28,
        deltaY: 6,
        side: "right",
        velocityX: -0.9,
      }),
    ).toBe("open");
  });

  it("cancels a fast vertical scroll with incidental leftward movement instead of opening the right panel", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        deltaX: -28,
        deltaY: 30,
        side: "right",
        velocityX: -0.9,
      }),
    ).toBe("cancel");
  });

  it("closes a panel on a quick horizontal flick before the sustained distance", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        action: "close",
        deltaX: 28,
        deltaY: 6,
        side: "right",
        velocityX: 0.9,
      }),
    ).toBe("close");
  });

  it("keeps a slow horizontal drag pending so scrollable bodies can still scroll", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        action: "close",
        deltaX: 28,
        deltaY: 6,
        side: "right",
        velocityX: 0.1,
      }),
    ).toBe("pending");
  });

  it("ignores a fast flick in the wrong direction", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        action: "close",
        deltaX: -28,
        deltaY: 6,
        side: "right",
        velocityX: -0.9,
      }),
    ).toBe("cancel");
  });

  it("cancels a fast vertical scroll with incidental rightward movement instead of closing the right panel", () => {
    expect(
      resolveMobileEdgeSwipeDecision({
        action: "close",
        deltaX: 28,
        deltaY: 30,
        side: "right",
        velocityX: 0.9,
      }),
    ).toBe("cancel");
  });

  it("accepts starts within the configured left edge band", () => {
    expect(isMobileEdgeSwipeStart({ viewportWidth: 390, x: 63, side: "left" })).toBe(true);
    expect(isMobileEdgeSwipeStart({ viewportWidth: 390, x: 65, side: "left" })).toBe(false);
  });

  it("accepts starts within the configured right edge band", () => {
    expect(isMobileEdgeSwipeStart({ viewportWidth: 390, x: 327, side: "right" })).toBe(true);
    expect(isMobileEdgeSwipeStart({ viewportWidth: 390, x: 325, side: "right" })).toBe(false);
  });

  it("accepts starts anywhere in the viewport for full-screen left swipes", () => {
    expect(
      isMobileEdgeSwipeStart({
        side: "left",
        startArea: "screen",
        viewportWidth: 390,
        x: 195,
      }),
    ).toBe(true);
  });

  it("accepts starts anywhere in the viewport for full-screen right swipes", () => {
    expect(
      isMobileEdgeSwipeStart({
        side: "right",
        startArea: "screen",
        viewportWidth: 390,
        x: 195,
      }),
    ).toBe(true);
  });
});

describe("resolveHorizontalScrollOwnerSwipeDecision", () => {
  it("cancels a right-panel close gesture when the scroll owner started away from the left edge", () => {
    expect(
      resolveHorizontalScrollOwnerSwipeDecision({
        action: "close",
        deltaX: 28,
        side: "right",
        startMaxScrollLeft: 400,
        startScrollLeft: 100,
        startSurface: "panel",
      }),
    ).toBe("cancel-panel-swipe");
  });

  it("allows a right-panel close gesture when the scroll owner started at the left edge", () => {
    expect(
      resolveHorizontalScrollOwnerSwipeDecision({
        action: "close",
        deltaX: 28,
        side: "right",
        startMaxScrollLeft: 400,
        startScrollLeft: 0,
        startSurface: "panel",
      }),
    ).toBe("allow-panel-swipe");
  });

  it("uses the starting scroll position rather than handing off after a drag reaches the edge", () => {
    expect(
      resolveHorizontalScrollOwnerSwipeDecision({
        action: "close",
        deltaX: 96,
        side: "right",
        startMaxScrollLeft: 400,
        startScrollLeft: 2,
        startSurface: "panel",
      }),
    ).toBe("cancel-panel-swipe");
  });

  it("does not let open gestures take over horizontally scrollable content", () => {
    expect(
      resolveHorizontalScrollOwnerSwipeDecision({
        action: "open",
        deltaX: -64,
        side: "right",
        startMaxScrollLeft: 400,
        startScrollLeft: 0,
        startSurface: "outside-panels",
      }),
    ).toBe("cancel-panel-swipe");
  });

  it("waits when movement over a scroll owner is opposite the close direction", () => {
    expect(
      resolveHorizontalScrollOwnerSwipeDecision({
        action: "close",
        deltaX: -28,
        side: "right",
        startMaxScrollLeft: 400,
        startScrollLeft: 0,
        startSurface: "panel",
      }),
    ).toBe("pending");
  });
});

describe("hasActiveTextSelection", () => {
  it("detects non-collapsed text selections", () => {
    expect(hasActiveTextSelection({ isCollapsed: false, rangeCount: 1 })).toBe(true);
  });

  it("ignores collapsed and empty selections", () => {
    expect(hasActiveTextSelection({ isCollapsed: true, rangeCount: 1 })).toBe(false);
    expect(hasActiveTextSelection({ isCollapsed: false, rangeCount: 0 })).toBe(false);
    expect(hasActiveTextSelection(null)).toBe(false);
  });
});
