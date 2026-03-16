import { describe, expect, it } from "vitest";

import {
  resolveSwipeGestureState,
  SCROLL_CANCEL_PX,
  SWIPE_AXIS_RATIO,
  SWIPE_LOCK_PX,
} from "./sidebar.swipe.logic";

describe("resolveSwipeGestureState", () => {
  describe("terminal states pass through unchanged", () => {
    it("returns swiping unchanged when already swiping", () => {
      // Any delta — even one that would cancel — should not override a committed state
      expect(
        resolveSwipeGestureState("swiping", { dx: 0, dy: SCROLL_CANCEL_PX + 1 }),
      ).toBe("swiping");
    });

    it("returns cancelled unchanged when already cancelled", () => {
      // Any delta — even one that would lock-in — should not override a committed state
      expect(
        resolveSwipeGestureState("cancelled", {
          dx: SWIPE_LOCK_PX + 1,
          dy: 0,
        }),
      ).toBe("cancelled");
    });
  });

  describe("scroll cancellation", () => {
    it("cancels when vertical movement exceeds SCROLL_CANCEL_PX", () => {
      expect(
        resolveSwipeGestureState("idle", { dx: 0, dy: SCROLL_CANCEL_PX + 1 }),
      ).toBe("cancelled");
    });

    it("does not cancel when vertical movement is exactly at SCROLL_CANCEL_PX", () => {
      // Rule uses strict >, so equality stays idle
      expect(
        resolveSwipeGestureState("idle", { dx: 0, dy: SCROLL_CANCEL_PX }),
      ).toBe("idle");
    });

    it("cancels even when horizontal movement would otherwise qualify for lock-in", () => {
      // Vertical exceeds cancel threshold, so cancel wins regardless of horizontal
      expect(
        resolveSwipeGestureState("idle", {
          dx: SWIPE_LOCK_PX + 1,
          dy: SCROLL_CANCEL_PX + 1,
        }),
      ).toBe("cancelled");
    });
  });

  describe("swipe lock-in", () => {
    it("locks in when horizontal exceeds SWIPE_LOCK_PX and is more than 2x the vertical", () => {
      const dy = 5;
      const dx = dy * SWIPE_AXIS_RATIO + SWIPE_LOCK_PX; // satisfies both distance and ratio
      expect(resolveSwipeGestureState("idle", { dx, dy })).toBe("swiping");
    });

    it("does not lock in when horizontal is exactly at SWIPE_LOCK_PX", () => {
      // Rule uses strict >, so equality stays idle
      expect(
        resolveSwipeGestureState("idle", { dx: SWIPE_LOCK_PX, dy: 0 }),
      ).toBe("idle");
    });

    it("does not lock in when horizontal is not 2x the vertical", () => {
      // dy = SCROLL_CANCEL_PX → no cancel triggered (strict >)
      // dx = SWIPE_LOCK_PX + 2 → exceeds distance threshold
      // but SWIPE_LOCK_PX + 2 (22) is NOT > SCROLL_CANCEL_PX * SWIPE_AXIS_RATIO (24) → ratio fails
      const dy = SCROLL_CANCEL_PX;
      const dx = SWIPE_LOCK_PX + 2;
      expect(resolveSwipeGestureState("idle", { dx, dy })).toBe("idle");
    });

    it("does not lock in when only the axis ratio is met but distance is insufficient", () => {
      // dx=10 satisfies ratio (dy=4, 10 > 4*2=8) but dx(10) is NOT > SWIPE_LOCK_PX(20)
      expect(
        resolveSwipeGestureState("idle", { dx: 10, dy: 4 }),
      ).toBe("idle");
    });
  });

  describe("idle state", () => {
    it("stays idle for small diagonal movement", () => {
      // Both dx and dy are small — well under all thresholds
      expect(
        resolveSwipeGestureState("idle", { dx: 5, dy: 3 }),
      ).toBe("idle");
    });

    it("stays idle at zero delta", () => {
      expect(
        resolveSwipeGestureState("idle", { dx: 0, dy: 0 }),
      ).toBe("idle");
    });
  });
});
