import { describe, expect, it } from "vite-plus/test";

import {
  LIVE_REFRESH_IDLE_AFTER_MS,
  LIVE_REFRESH_INTERVAL_MS,
  LIVE_REFRESH_MIN_INTERVAL_MS,
  shouldLiveRefresh,
  shouldRefreshOnArrival,
  shouldRefreshOnInterval,
} from "./useLiveRefresh";

describe("live refresh cadence", () => {
  it("waits five minutes between automatic host reads", () => {
    expect(LIVE_REFRESH_INTERVAL_MS).toBe(5 * 60_000);
  });
});

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

  it("reads on the first interval after an untouched mount", () => {
    expect(tick(LIVE_REFRESH_INTERVAL_MS + 1_000, 0)).toBe(true);
  });

  it("stops reading for a window left showing on a desk nobody is at", () => {
    expect(tick(LIVE_REFRESH_IDLE_AFTER_MS + 60_000, 0)).toBe(false);
  });

  it("starts reading again once the reader touches the window", () => {
    const away = LIVE_REFRESH_IDLE_AFTER_MS + 60_000;
    expect(tick(away + LIVE_REFRESH_MIN_INTERVAL_MS, away)).toBe(true);
  });
});
