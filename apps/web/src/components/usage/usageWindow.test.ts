import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ALL_TIME_WINDOW_DAYS, makeUsageWindow, trimUsageWindow } from "./usageWindow";

const window: UsageSummaryInput = {
  sinceDay: UsageDay.make("1970-01-01"),
  untilDay: UsageDay.make("2026-01-15"),
  timeZone: "Pacific/Kiritimati",
  resolution: "day",
};

describe("Usage windows", () => {
  afterEach(() => vi.useRealTimers());

  it("requests all history on selection and refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-01-15T12:00:00Z");
    const selected = makeUsageWindow(ALL_TIME_WINDOW_DAYS);
    expect(selected.sinceDay).toBe("1970-01-01");
    expect(selected.resolution).toBe("day");
    vi.setSystemTime("2026-01-16T12:00:00Z");
    const refreshed = makeUsageWindow(ALL_TIME_WINDOW_DAYS);
    expect(refreshed.sinceDay).toBe(selected.sinceDay);
    expect(refreshed.untilDay > selected.untilDay).toBe(true);
  });

  it("starts at the first usage day, including unpriced tokens", () => {
    const daily = [
      { day: "2024-12-31", costUsd: 0, totalTokens: 10, byProvider: new Map() },
      { day: "2026-01-15", costUsd: 1, totalTokens: 20, byProvider: new Map() },
    ];
    expect(trimUsageWindow(window, daily)).toEqual({ ...window, sinceDay: "2024-12-31" });
    expect(window.sinceDay).toBe("1970-01-01");
  });

  it("shows 30 calendar days when empty, even across a year boundary", () => {
    expect(trimUsageWindow(window, [])).toEqual({ ...window, sinceDay: "2025-12-17" });
  });

  it("preserves a fixed window while a different selection is loading", () => {
    const fixed = { ...window, sinceDay: UsageDay.make("2026-01-09") };
    expect(trimUsageWindow(fixed, [])).toBe(fixed);
  });
});
