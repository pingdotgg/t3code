import { describe, expect, it, vi } from "vite-plus/test";

import { createSwipeableScrollGate } from "./swipe-scroll-gate";

describe("createSwipeableScrollGate", () => {
  it("unlocks when momentum starts but onMomentumScrollEnd never fires", () => {
    vi.useFakeTimers();
    try {
      let active = false;
      const gate = createSwipeableScrollGate((next) => {
        active = next;
      });

      gate.onScrollBeginDrag(0);
      gate.onScroll(12);
      expect(active).toBe(true);

      gate.onScrollEndDrag();
      gate.onMomentumScrollBegin();
      expect(active).toBe(true);

      vi.advanceTimersByTime(159);
      expect(active).toBe(true);

      vi.advanceTimersByTime(1);
      expect(active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays active across momentum scroll ticks and unlocks immediately on momentum end", () => {
    vi.useFakeTimers();
    try {
      let active = false;
      const gate = createSwipeableScrollGate((next) => {
        active = next;
      });

      gate.onScrollBeginDrag(0);
      gate.onScroll(20);
      gate.onScrollEndDrag();
      gate.onMomentumScrollBegin();

      for (let step = 1; step <= 4; step += 1) {
        vi.advanceTimersByTime(100);
        gate.onScroll(20 + step * 50);
        expect(active).toBe(true);
      }

      gate.onMomentumScrollEnd();
      expect(active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unlocks when a drag is cancelled and onScrollEndDrag never fires", () => {
    vi.useFakeTimers();
    try {
      let active = false;
      const gate = createSwipeableScrollGate((next) => {
        active = next;
      });

      gate.onScrollBeginDrag(0);
      gate.onScroll(24);
      expect(active).toBe(true);

      vi.advanceTimersByTime(159);
      expect(active).toBe(true);

      vi.advanceTimersByTime(1);
      expect(active).toBe(false);

      gate.onScroll(60);
      expect(active).toBe(true);
      gate.onScroll(100);
      expect(active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the settle fallback armed when a new drag catches active momentum", () => {
    vi.useFakeTimers();
    try {
      let active = false;
      const gate = createSwipeableScrollGate((next) => {
        active = next;
      });

      gate.onScrollBeginDrag(0);
      gate.onScroll(30);
      gate.onScrollEndDrag();
      gate.onMomentumScrollBegin();
      vi.advanceTimersByTime(80);
      gate.onScrollBeginDrag(200);
      expect(active).toBe(true);

      vi.advanceTimersByTime(160);
      expect(active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
