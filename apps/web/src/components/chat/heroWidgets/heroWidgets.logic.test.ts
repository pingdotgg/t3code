import type { DailyTotals, HourlyTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPunchcard,
  buildSpendSeries,
  fitWidgetGrid,
  formatHour,
  hourlyDayWindows,
  monthToDateWindow,
} from "./heroWidgets.logic";

function hourly(at: Date, totalTokens: number): HourlyTotals {
  return {
    day: "",
    hourStart: at.toISOString(),
    costUsd: 0,
    totalTokens,
    byProvider: new Map(),
  };
}

function daily(day: string, costUsd: number): DailyTotals {
  return { day, costUsd, totalTokens: 0, byProvider: new Map() };
}

describe("hourlyDayWindows", () => {
  it("returns one window per local day, none longer than 24 hours, ending now", () => {
    const now = new Date(2026, 10, 17, 13, 45, 30);
    const windows = hourlyDayWindows(now, 7);

    expect(windows).toHaveLength(7);
    for (const window of windows) {
      expect(window.resolution).toBe("hour");
      const span = Date.parse(window.untilTime!) - Date.parse(window.sinceTime!);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
    }
    expect(new Date(windows[0]!.sinceTime!)).toEqual(new Date(2026, 10, 11));
    expect(new Date(windows[6]!.sinceTime!)).toEqual(new Date(2026, 10, 17));
    expect(new Date(windows[6]!.untilTime!)).toEqual(new Date(2026, 10, 17, 13, 45));
    expect(windows[6]!.sinceDay).toBe("2026-11-17");
    expect(windows[6]!.untilDay).toBe("2026-11-17");
  });
});

describe("monthToDateWindow", () => {
  it("spans the first of the month through today", () => {
    const window = monthToDateWindow(new Date(2026, 10, 17, 9));
    expect(window.sinceDay).toBe("2026-11-01");
    expect(window.untilDay).toBe("2026-11-17");
    expect(window.resolution).toBe("day");
  });
});

describe("buildPunchcard", () => {
  it("bins tokens by local day and hour and finds the peak", () => {
    const now = new Date(2026, 10, 17, 23);
    const card = buildPunchcard(now, 7, [
      hourly(new Date(2026, 10, 17, 22), 500),
      hourly(new Date(2026, 10, 17, 22), 100),
      hourly(new Date(2026, 10, 11, 9), 50),
      hourly(new Date(2026, 10, 1, 9), 9_999),
    ]);

    expect(card.rows).toHaveLength(7);
    expect(card.rows[6]!.hours[22]).toBe(600);
    expect(card.rows[0]!.hours[9]).toBe(50);
    expect(card.max).toBe(600);
    expect(card.peak).toEqual({ label: card.rows[6]!.label, hour: 22 });
  });

  it("has no peak without usage", () => {
    expect(buildPunchcard(new Date(2026, 10, 17), 7, []).peak).toBeNull();
  });
});

describe("buildSpendSeries", () => {
  it("accumulates daily cost and projects the month at the current pace", () => {
    const now = new Date(2026, 10, 3, 0);
    const series = buildSpendSeries(now, [daily("2026-11-01", 10), daily("2026-11-02", 20)]);

    expect(series.daysInMonth).toBe(30);
    expect(series.cumulative).toEqual([10, 30, 30]);
    expect(series.monthToDate).toBe(30);
    expect(series.pace).toBeCloseTo(450);
  });
});

describe("formatHour", () => {
  it("formats 12-hour clock labels", () => {
    expect(formatHour(0)).toBe("12 AM");
    expect(formatHour(13)).toBe("1 PM");
    expect(formatHour(12)).toBe("12 PM");
  });
});

describe("fitWidgetGrid", () => {
  it("fills 3 by 2 on a wide, tall pane", () => {
    expect(fitWidgetGrid({ width: 2400, height: 600 }, 8)).toEqual({
      columns: 3,
      rows: 2,
      rowHeight: 236,
    });
  });

  it("drops to one row when only one fits", () => {
    expect(fitWidgetGrid({ width: 2400, height: 300 }, 8)).toMatchObject({ columns: 3, rows: 1 });
  });

  it("uses fewer columns on a narrow pane", () => {
    expect(fitWidgetGrid({ width: 700, height: 600 }, 8)).toMatchObject({ columns: 2, rows: 2 });
  });

  it("shows nothing when a card cannot fit", () => {
    expect(fitWidgetGrid({ width: 2400, height: 150 }, 8)).toBeNull();
    expect(fitWidgetGrid({ width: 200, height: 600 }, 8)).toBeNull();
  });
});
