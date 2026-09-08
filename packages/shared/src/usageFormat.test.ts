// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import type { DailyTotals } from "./usageMerge.ts";
import {
  enumerateChartDays,
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatRelativeHourShort,
  groupDailyByWeek,
  makeWindow,
  USAGE_ALL_TIME_SINCE_DAY,
  weekStart,
} from "./usageFormat.ts";

function dayTotals(day: string, codex: number, claude = 0): DailyTotals {
  return {
    day,
    costUsd: codex + claude,
    totalTokens: (codex + claude) * 10,
    byProvider: new Map([
      ["codex", { costUsd: codex, totalTokens: codex * 10 }],
      ...(claude === 0 ? [] : [["claude", { costUsd: claude, totalTokens: claude * 10 }] as const]),
    ]),
  };
}

describe("all-time usage windows", () => {
  it("requests everything from the fixed floor day", () => {
    const window = makeWindow("all", new Date("2026-08-11T12:37:42.123Z"));

    expect(window.sinceDay).toBe(USAGE_ALL_TIME_SINCE_DAY);
    expect(window.untilDay).toBe("2026-08-11");
    expect(window.resolution).toBe("day");
  });

  it("charts an all-time window from its first active day, and a bounded one in full", () => {
    const window = makeWindow("all", new Date("2026-08-11T12:37:42.123Z"));
    const daily = [dayTotals("2026-08-09", 1), dayTotals("2026-08-10", 2)];

    expect(enumerateChartDays(window, daily)).toEqual(["2026-08-09", "2026-08-10", "2026-08-11"]);
    expect(enumerateChartDays(window, [])).toEqual(["2026-08-11"]);
    expect(enumerateChartDays(makeWindow(3, new Date("2026-08-11T12:37:42.123Z")), [])).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
  });
});

describe("weekly chart buckets", () => {
  it("starts weeks on Monday", () => {
    expect(weekStart("2026-08-10")).toBe("2026-08-10");
    expect(weekStart("2026-08-16")).toBe("2026-08-10");
    expect(weekStart("2026-08-09")).toBe("2026-08-03");
  });

  it("sums days into their week and zero-fills quiet weeks between", () => {
    const days = ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-25"];
    const { periods, totals } = groupDailyByWeek(days, [
      dayTotals("2026-08-05", 1, 2),
      dayTotals("2026-08-07", 3),
      dayTotals("2026-08-25", 5),
    ]);

    expect(periods).toEqual(["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]);
    expect(totals.map((week) => [week.day, week.costUsd])).toEqual([
      ["2026-08-03", 6],
      ["2026-08-24", 5],
    ]);
    expect(totals[0]?.byProvider.get("codex")).toEqual({ costUsd: 4, totalTokens: 40 });
    expect(totals[0]?.byProvider.get("claude")).toEqual({ costUsd: 2, totalTokens: 20 });
  });
});

describe("hourly usage formatting", () => {
  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
