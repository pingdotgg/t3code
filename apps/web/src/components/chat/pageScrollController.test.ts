import { describe, expect, test } from "vite-plus/test";
import { ChatPageScrollFraction } from "@t3tools/contracts/settings";

import {
  createPageScrollController,
  getTimelinePageScrollKey,
  getPageScrollDistancePx,
  getPageScrollMultiplier,
  getPageScrollVelocityPxPerMs,
  PAGE_SCROLL_ACCELERATION_MS,
  PAGE_SCROLL_ANIMATION_MS,
  PAGE_SCROLL_MAX_MULTIPLIER,
} from "./pageScrollController";

class TestClock {
  private currentTime = 0;
  private nextHandle = 1;
  private animationFrames = new Map<number, FrameRequestCallback>();
  private timeouts = new Map<number, { at: number; callback: () => void }>();

  readonly env = {
    now: () => this.currentTime,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.animationFrames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => {
      this.animationFrames.delete(handle);
    },
    setTimeout: (callback: () => void, delay: number) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.timeouts.set(handle, { at: this.currentTime + delay, callback });
      return handle;
    },
    clearTimeout: (handle: number) => {
      this.timeouts.delete(handle);
    },
  };

  advanceBy(ms: number, frameMs = 16) {
    const target = this.currentTime + ms;

    while (this.currentTime < target) {
      this.currentTime = Math.min(target, this.currentTime + frameMs);
      this.flushTimeouts();
      this.flushAnimationFrames();
    }
  }

  private flushTimeouts() {
    let hasDueTimeouts = true;
    while (hasDueTimeouts) {
      hasDueTimeouts = false;

      for (const [handle, timeout] of this.timeouts) {
        if (timeout.at > this.currentTime) {
          continue;
        }

        this.timeouts.delete(handle);
        timeout.callback();
        hasDueTimeouts = true;
      }
    }
  }

  private flushAnimationFrames() {
    if (this.animationFrames.size === 0) {
      return;
    }

    const frames = [...this.animationFrames.values()];
    this.animationFrames.clear();

    for (const callback of frames) {
      callback(this.currentTime);
    }
  }
}

describe("page scroll helpers", () => {
  const composerPageScrollEvent = (
    overrides: Partial<Parameters<typeof getTimelinePageScrollKey>[0]> = {},
  ) => ({
    altKey: false,
    clientHeight: 200,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key: "PageDown",
    keyCode: 34,
    metaKey: false,
    scrollHeight: 200,
    scrollTop: 0,
    shiftKey: false,
    ...overrides,
  });

  test("leaves page keys to IME composition", () => {
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ isComposing: true }))).toBeNull();
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ keyCode: 229 }))).toBeNull();
  });

  test.each(["altKey", "ctrlKey", "metaKey", "shiftKey", "defaultPrevented"] as const)(
    "leaves modified or handled composer keys alone: %s",
    (flag) => {
      expect(getTimelinePageScrollKey(composerPageScrollEvent({ [flag]: true }))).toBeNull();
    },
  );

  test.each([
    [600, 24, 1, 540],
    [600, 24, 0.5, 270],
    [60, 40, 0.5, 0],
  ] as const)(
    "scales the usable page after composer padding and alignment: %s, %s, %s",
    (containerHeightPx, scrollPaddingBottomPx, pageScrollFraction, expectedDistance) => {
      expect(
        getPageScrollDistancePx({ containerHeightPx, scrollPaddingBottomPx, pageScrollFraction }),
      ).toBe(expectedDistance);
    },
  );

  test("leaves page keys to an overflowing composer until it reaches the boundary", () => {
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 0 })),
    ).toBeNull();
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 400,
        }),
      ),
    ).toBeNull();

    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 400 })),
    ).toBe("PageDown");
  });

  test("hands off page keys within a fractional pixel of the composer boundary", () => {
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0.5,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 399.5 })),
    ).toBe("PageDown");
  });

  test("ramps multiplier over time and caps at the max velocity", () => {
    expect(getPageScrollMultiplier(0)).toBe(1);
    expect(getPageScrollMultiplier(PAGE_SCROLL_ACCELERATION_MS / 2)).toBeCloseTo(1.5);
    expect(getPageScrollMultiplier(PAGE_SCROLL_ACCELERATION_MS * 5)).toBe(
      PAGE_SCROLL_MAX_MULTIPLIER,
    );
  });

  test("derives the hold velocity from page size and acceleration", () => {
    expect(
      getPageScrollVelocityPxPerMs({
        holdElapsedMs: 0,
        pageScrollDistancePx: 600,
      }),
    ).toBeCloseTo(4);
    expect(
      getPageScrollVelocityPxPerMs({
        holdElapsedMs: PAGE_SCROLL_ACCELERATION_MS * 5,
        pageScrollDistancePx: 600,
      }),
    ).toBeCloseTo(8);
  });
});

describe("createPageScrollController", () => {
  test.each(["PageUp", "PageDown"] as const)("scrolls half a usable page on a %s tap", (key) => {
    const clock = new TestClock();
    const container = {
      clientHeight: 600,
      scrollHeight: 4_000,
      scrollTop: 1_000,
      getBoundingClientRect: () => ({ height: 600 }),
    };
    const controller = createPageScrollController({
      getContainer: () => container,
      getScrollPaddingBottomPx: () => 24,
      getPageScrollFraction: () => 0.5,
      env: clock.env,
    });

    controller.handleKeyDown(key);
    controller.handleKeyUp(key);
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);

    expect(container.scrollTop).toBeCloseTo(key === "PageUp" ? 730 : 1_270, 5);
  });

  test.each(["PageUp", "PageDown"] as const)(
    "halves held %s scrolling through acceleration and stops on keyup",
    (key) => {
      const clock = new TestClock();
      const cases = ChatPageScrollFraction.literals.map((fraction) => {
        const container = {
          clientHeight: 600,
          scrollHeight: 20_000,
          scrollTop: 10_000,
          getBoundingClientRect: () => ({ height: 600 }),
        };
        const controller = createPageScrollController({
          getContainer: () => container,
          getScrollPaddingBottomPx: () => 24,
          getPageScrollFraction: () => fraction,
          env: clock.env,
        });
        controller.handleKeyDown(key);
        return { container, controller };
      });
      const [full, half] = cases;
      expect(full).toBeDefined();
      expect(half).toBeDefined();
      if (!full || !half) return;

      for (const elapsed of [PAGE_SCROLL_ANIMATION_MS + 50, PAGE_SCROLL_ACCELERATION_MS * 2]) {
        clock.advanceBy(elapsed);
        expect(half.container.scrollTop - 10_000).toBeCloseTo(
          (full.container.scrollTop - 10_000) / 2,
          5,
        );
      }

      const stoppedAt = cases.map(({ container, controller }) => {
        controller.handleKeyUp(key);
        return container.scrollTop;
      });
      clock.advanceBy(250);
      expect(cases.map(({ container }) => container.scrollTop)).toEqual(stoppedAt);
    },
  );

  test("reads changed fractions for the next tap and during a hold", () => {
    const clock = new TestClock();
    let fraction: ChatPageScrollFraction = 1;
    const container = {
      clientHeight: 600,
      scrollHeight: 20_000,
      scrollTop: 0,
      getBoundingClientRect: () => ({ height: 600 }),
    };
    const controller = createPageScrollController({
      getContainer: () => container,
      getScrollPaddingBottomPx: () => 24,
      getPageScrollFraction: () => fraction,
      env: clock.env,
    });

    controller.handleKeyDown("PageDown");
    controller.handleKeyUp("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);
    expect(container.scrollTop).toBeCloseTo(540, 5);

    fraction = 0.5;
    controller.handleKeyDown("PageDown");
    controller.handleKeyUp("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);
    expect(container.scrollTop).toBeCloseTo(810, 5);

    fraction = 1;
    controller.handleKeyDown("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS + PAGE_SCROLL_ACCELERATION_MS * 2);
    const beforeFullFrame = container.scrollTop;
    clock.advanceBy(16);
    const fullFrameDistance = container.scrollTop - beforeFullFrame;

    fraction = 0.5;
    const beforeHalfFrame = container.scrollTop;
    clock.advanceBy(16);
    expect(container.scrollTop - beforeHalfFrame).toBeCloseTo(fullFrameDistance / 2, 5);
    controller.dispose();
  });

  test("keeps a single page scroll when the key is tapped", () => {
    const clock = new TestClock();
    const container = {
      clientHeight: 600,
      scrollHeight: 1_800,
      scrollTop: 0,
      getBoundingClientRect: () => ({ height: 600 }),
    };
    const controller = createPageScrollController({
      getContainer: () => container,
      getScrollPaddingBottomPx: () => 24,
      env: clock.env,
    });

    controller.handleKeyDown("PageDown");
    controller.handleKeyUp("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS);

    expect(container.scrollTop).toBeCloseTo(
      getPageScrollDistancePx({
        containerHeightPx: 600,
        scrollPaddingBottomPx: 24,
      }),
      5,
    );
  });

  test("continues scrolling on hold without repeated keydown events and stops on keyup", () => {
    const clock = new TestClock();
    const container = {
      clientHeight: 600,
      scrollHeight: 4_000,
      scrollTop: 0,
      getBoundingClientRect: () => ({ height: 600 }),
    };
    const controller = createPageScrollController({
      getContainer: () => container,
      getScrollPaddingBottomPx: () => 24,
      env: clock.env,
    });
    controller.handleKeyDown("PageDown");
    clock.advanceBy(PAGE_SCROLL_ANIMATION_MS + 50);

    const afterHoldStarts = container.scrollTop;
    clock.advanceBy(200);

    expect(container.scrollTop).toBeGreaterThan(afterHoldStarts);

    const stoppedAt = container.scrollTop;
    controller.handleKeyUp("PageDown");
    clock.advanceBy(250);

    expect(container.scrollTop).toBe(stoppedAt);
  });

  test("notifies once when a page scroll starts", () => {
    const clock = new TestClock();
    const started: string[] = [];
    const controller = createPageScrollController({
      getContainer: () => ({
        clientHeight: 600,
        scrollHeight: 1_800,
        scrollTop: 600,
        getBoundingClientRect: () => ({ height: 600 }),
      }),
      getScrollPaddingBottomPx: () => 24,
      onScrollStart: (key) => started.push(key),
      env: clock.env,
    });

    controller.handleKeyDown("PageUp");
    controller.handleKeyDown("PageUp");

    expect(started).toEqual(["PageUp"]);
  });

  test.each(ChatPageScrollFraction.literals)(
    "does not start a page scroll at the timeline boundary with fraction %s",
    (fraction) => {
      const clock = new TestClock();
      const started: string[] = [];
      const container = {
        clientHeight: 600,
        scrollHeight: 1_800,
        scrollTop: 0.5,
        getBoundingClientRect: () => ({ height: 600 }),
      };
      const controller = createPageScrollController({
        getContainer: () => container,
        getScrollPaddingBottomPx: () => 24,
        getPageScrollFraction: () => fraction,
        onScrollStart: (key) => started.push(key),
        env: clock.env,
      });

      controller.handleKeyDown("PageUp");
      clock.advanceBy(PAGE_SCROLL_ANIMATION_MS * 2);

      container.scrollTop = container.scrollHeight - container.clientHeight - 0.5;
      controller.handleKeyDown("PageDown");
      clock.advanceBy(PAGE_SCROLL_ANIMATION_MS * 2);

      expect(started).toEqual([]);
      expect(container.scrollTop).toBe(1_199.5);
    },
  );
});
