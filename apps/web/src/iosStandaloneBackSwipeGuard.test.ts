import { describe, expect, it, vi } from "vitest";

import {
  IOS_HISTORY_SWIPE_EDGE_WIDTH_PX,
  installIosStandaloneBackSwipeGuard,
  isHistorySwipeEdgeTouch,
  isIosTouchDevice,
  shouldInstallIosStandaloneBackSwipeGuard,
  shouldPreventIosHistorySwipeTouchStart,
} from "./iosStandaloneBackSwipeGuard";

describe("isIosTouchDevice", () => {
  it("detects iPhones from the user agent", () => {
    expect(
      isIosTouchDevice({
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
  });

  it("detects iPadOS devices that report a Mac platform", () => {
    expect(
      isIosTouchDevice({
        maxTouchPoints: 5,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
  });

  it("does not detect desktop Safari as an iOS touch device", () => {
    expect(
      isIosTouchDevice({
        maxTouchPoints: 0,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      }),
    ).toBe(false);
  });
});

describe("shouldInstallIosStandaloneBackSwipeGuard", () => {
  it("installs only for iOS standalone PWAs", () => {
    expect(
      shouldInstallIosStandaloneBackSwipeGuard({
        isStandalonePwa: true,
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
      }),
    ).toBe(true);

    expect(
      shouldInstallIosStandaloneBackSwipeGuard({
        isStandalonePwa: false,
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
      }),
    ).toBe(false);
  });
});

describe("isHistorySwipeEdgeTouch", () => {
  it("matches touches that start at either horizontal viewport edge", () => {
    expect(
      isHistorySwipeEdgeTouch({
        clientX: IOS_HISTORY_SWIPE_EDGE_WIDTH_PX,
        viewportWidth: 390,
      }),
    ).toBe(true);
    expect(
      isHistorySwipeEdgeTouch({
        clientX: 390 - IOS_HISTORY_SWIPE_EDGE_WIDTH_PX,
        viewportWidth: 390,
      }),
    ).toBe(true);
  });

  it("allows touches away from the horizontal viewport edges", () => {
    expect(
      isHistorySwipeEdgeTouch({
        clientX: IOS_HISTORY_SWIPE_EDGE_WIDTH_PX + 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      isHistorySwipeEdgeTouch({
        clientX: 390 - IOS_HISTORY_SWIPE_EDGE_WIDTH_PX - 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
  });
});

describe("shouldPreventIosHistorySwipeTouchStart", () => {
  it("prevents cancelable single-touch starts at an edge", () => {
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: false,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(true);
  });

  it("allows already-handled, non-cancelable, multi-touch, and non-edge starts", () => {
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: false,
        clientX: 4,
        defaultPrevented: false,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: true,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 4,
        defaultPrevented: false,
        touchCount: 2,
        viewportWidth: 390,
      }),
    ).toBe(false);
    expect(
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: true,
        clientX: 100,
        defaultPrevented: false,
        touchCount: 1,
        viewportWidth: 390,
      }),
    ).toBe(false);
  });
});

describe("installIosStandaloneBackSwipeGuard", () => {
  it("installs a non-passive capture touchstart listener for iOS standalone PWAs", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const targetWindow = {
      addEventListener,
      document: { documentElement: { clientWidth: 390 } },
      innerWidth: 390,
      navigator: {
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
      },
      removeEventListener,
    } as unknown as Window;

    const cleanup = installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => true,
      window: targetWindow,
    });

    expect(addEventListener).toHaveBeenCalledWith(
      "touchstart",
      expect.any(Function),
      expect.objectContaining({ capture: true, passive: false }),
    );

    const listener = addEventListener.mock.calls[0]?.[1] as (event: TouchEvent) => void;
    const preventDefault = vi.fn();
    listener({
      cancelable: true,
      defaultPrevented: false,
      preventDefault,
      touches: {
        item: () => ({ clientX: 4 }),
        length: 1,
      },
    } as unknown as TouchEvent);

    expect(preventDefault).toHaveBeenCalledTimes(1);

    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("touchstart", listener, true);
  });

  it("does not install outside iOS standalone PWAs", () => {
    const addEventListener = vi.fn();
    const targetWindow = {
      addEventListener,
      document: { documentElement: { clientWidth: 390 } },
      innerWidth: 390,
      navigator: {
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)",
      },
      removeEventListener: vi.fn(),
    } as unknown as Window;

    installIosStandaloneBackSwipeGuard({
      isStandalonePwa: () => false,
      window: targetWindow,
    });

    expect(addEventListener).not.toHaveBeenCalled();
  });
});
