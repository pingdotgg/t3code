import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startUsageAutoRefresh, USAGE_AUTO_REFRESH_MS } from "./usageRefresh.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("startUsageAutoRefresh", () => {
  it("refreshes immediately, repeats every thirty minutes, and stops after cleanup", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const stop = startUsageAutoRefresh(refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(USAGE_AUTO_REFRESH_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(USAGE_AUTO_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(USAGE_AUTO_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
