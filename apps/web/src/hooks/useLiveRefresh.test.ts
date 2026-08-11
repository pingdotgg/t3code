import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { installReactHookTestDom, mountReactHookTestComponent } from "../test/reactDomHookHarness";
import {
  LIVE_REFRESH_IDLE_AFTER_MS,
  LIVE_REFRESH_INTERVAL_MS,
  LIVE_REFRESH_MIN_INTERVAL_MS,
  resolveLiveRefreshCadence,
  shouldLiveRefresh,
  shouldRefreshOnArrival,
  shouldRefreshOnInterval,
  useLiveRefresh,
} from "./useLiveRefresh";

afterEach(() => vi.useRealTimers());

describe("shouldLiveRefresh", () => {
  const at = (now: number, lastRefreshedAt: number, visible = true) =>
    shouldLiveRefresh({ visible, now, lastRefreshedAt });

  it("reads a view again when it is navigated to", () => {
    expect(at(LIVE_REFRESH_MIN_INTERVAL_MS, 0)).toBe(true);
  });

  it("does not read a view again that was left and returned to seconds later", () => {
    expect(at(3_000, 0)).toBe(false);
  });

  it("reads again when the interval comes round on a view left open", () => {
    expect(at(LIVE_REFRESH_INTERVAL_MS, 0)).toBe(true);
  });

  it("does not read again for every window tabbed through", () => {
    expect(at(1_000, 0)).toBe(false);
  });

  it("stays quiet while the window is not showing", () => {
    // A focus event can arrive for a window that is still hidden behind another one.
    expect(at(LIVE_REFRESH_MIN_INTERVAL_MS * 5, 0, false)).toBe(false);
  });

  it("reads once for a window hidden an hour, not once per interval it missed", () => {
    const hour = 60 * 60_000;
    let lastRefreshedAt = 0;
    let reads = 0;
    const tick = (now: number, visible: boolean) => {
      if (!at(now, lastRefreshedAt, visible)) return;
      lastRefreshedAt = now;
      reads += 1;
    };

    for (let now = LIVE_REFRESH_INTERVAL_MS; now < hour; now += LIVE_REFRESH_INTERVAL_MS) {
      tick(now, false);
    }
    // Coming back raises a visibility change and a focus event, one straight after the other.
    tick(hour, true);
    tick(hour, true);

    expect(reads).toBe(1);
  });
});

describe("resolveLiveRefreshCadence", () => {
  it("keeps existing callers on the 60-second interval and 10-second minimum", () => {
    expect(resolveLiveRefreshCadence()).toEqual({
      intervalMs: LIVE_REFRESH_INTERVAL_MS,
      minimumIntervalMs: LIVE_REFRESH_MIN_INTERVAL_MS,
    });
  });

  it("uses the quota cadence without reading hidden or idle windows", () => {
    const cadence = resolveLiveRefreshCadence({
      intervalMs: 30_000,
      minimumIntervalMs: 10_000,
    });

    expect(cadence).toEqual({ intervalMs: 30_000, minimumIntervalMs: 10_000 });
    expect(
      shouldRefreshOnInterval({
        visible: true,
        now: cadence.intervalMs,
        lastRefreshedAt: 0,
        lastInteractedAt: cadence.intervalMs - 1,
        minimumIntervalMs: cadence.minimumIntervalMs,
      }),
    ).toBe(true);
    expect(
      shouldRefreshOnInterval({
        visible: false,
        now: cadence.intervalMs,
        lastRefreshedAt: 0,
        lastInteractedAt: cadence.intervalMs - 1,
        minimumIntervalMs: cadence.minimumIntervalMs,
      }),
    ).toBe(false);
    expect(
      shouldRefreshOnInterval({
        visible: true,
        now: LIVE_REFRESH_IDLE_AFTER_MS + cadence.intervalMs,
        lastRefreshedAt: 0,
        lastInteractedAt: 0,
        minimumIntervalMs: cadence.minimumIntervalMs,
      }),
    ).toBe(false);
  });

  it("clamps explicit zero and negative cadences to a safe positive interval", () => {
    expect(resolveLiveRefreshCadence({ intervalMs: 0, minimumIntervalMs: -1 })).toEqual({
      intervalMs: 1_000,
      minimumIntervalMs: 1_000,
    });
  });
});

describe("useLiveRefresh", () => {
  it("uses the quota's 30-second timer without duplicate, hidden, or idle reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const dom = installReactHookTestDom();
    const refresh = vi.fn();
    const mounted = await mountReactHookTestComponent(
      createElement(() => {
        useLiveRefresh(refresh, {
          key: "quota-hook-cadence",
          intervalMs: 30_000,
          minimumIntervalMs: 10_000,
        });
        return null;
      }),
      dom.document,
    );

    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    dom.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_IDLE_AFTER_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    dom.setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    await mounted.unmount();
    dom.cleanup();
  });
});

describe("shouldRefreshOnArrival", () => {
  it("leaves a view alone the first time it is opened, because it is already reading", () => {
    expect(shouldRefreshOnArrival({ visible: true, now: 5_000, lastRefreshedAt: undefined })).toBe(
      false,
    );
  });

  it("reads a view that was read earlier in the session and returned to", () => {
    expect(shouldRefreshOnArrival({ visible: true, now: 90_000, lastRefreshedAt: 0 })).toBe(true);
  });

  it("keeps the minimum interval on a view returned to straight away", () => {
    expect(shouldRefreshOnArrival({ visible: true, now: 2_000, lastRefreshedAt: 0 })).toBe(false);
  });
});

describe("shouldRefreshOnInterval", () => {
  const tick = (now: number, lastInteractedAt: number) =>
    shouldRefreshOnInterval({ visible: true, now, lastRefreshedAt: 0, lastInteractedAt });

  it("reads for a reader who is here", () => {
    expect(tick(LIVE_REFRESH_INTERVAL_MS, LIVE_REFRESH_INTERVAL_MS - 1_000)).toBe(true);
  });

  it("stops reading for a window left showing on a desk nobody is at", () => {
    expect(tick(LIVE_REFRESH_IDLE_AFTER_MS + 60_000, 0)).toBe(false);
  });

  it("starts reading again once the reader touches the window", () => {
    const away = LIVE_REFRESH_IDLE_AFTER_MS + 60_000;
    expect(tick(away + LIVE_REFRESH_INTERVAL_MS, away)).toBe(true);
  });
});
