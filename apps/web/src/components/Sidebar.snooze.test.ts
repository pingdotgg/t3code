import { describe, expect, it } from "vite-plus/test";

import {
  defaultCustomSnoozeDateTime,
  formatSnoozeDateTimeLocal,
  parseCustomSnoozeDateTime,
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
} from "./Sidebar.snooze";

// Local-time constructor so preset math is timezone-stable in tests.
function localDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function withTimeZone<T>(timeZone: string, run: () => T): T {
  const previousTimeZone = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (previousTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimeZone;
    }
  }
}

describe("resolveSnoozePresets", () => {
  it("offers hour, evening, tomorrow, next week in the morning", () => {
    // Wednesday 2026-04-08 10:00 local.
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    const evening = presets.find((preset) => preset.id === "evening");
    expect(new Date(evening!.snoozedUntil).getHours()).toBe(18);
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    const tomorrowDate = new Date(tomorrow!.snoozedUntil);
    expect(tomorrowDate.getDate()).toBe(9);
    expect(tomorrowDate.getHours()).toBe(9);
    const nextWeek = presets.find((preset) => preset.id === "next-week");
    const nextWeekDate = new Date(nextWeek!.snoozedUntil);
    expect(nextWeekDate.getDay()).toBe(1);
    expect(nextWeekDate.getDate()).toBe(13);
  });

  it("whenLabel complements the label instead of repeating it", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
    for (const preset of presets) {
      // Day words live in the label column; the time column is time-only
      // (plus a weekday for next week, which names a different day).
      expect(preset.whenLabel.toLowerCase()).not.toContain("tomorrow");
    }
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    expect(tomorrow!.whenLabel).toMatch(/9/);
    const nextWeek = presets.find((preset) => preset.id === "next-week");
    expect(nextWeek!.whenLabel).toMatch(/Mon/);
  });

  it("drops the evening preset once evening is near or past", () => {
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 17, 30)).map((preset) => preset.id)).toEqual([
      "hour",
      "tomorrow",
      "next-week",
    ]);
    expect(resolveSnoozePresets(localDate(2026, 4, 8, 21)).map((preset) => preset.id)).toEqual([
      "hour",
      "tomorrow",
      "next-week",
    ]);
  });

  it("puts next week a full week out when today is Monday", () => {
    // Monday 2026-04-06.
    const presets = resolveSnoozePresets(localDate(2026, 4, 6, 10));
    const nextWeek = new Date(presets.find((preset) => preset.id === "next-week")!.snoozedUntil);
    expect(nextWeek.getDay()).toBe(1);
    expect(nextWeek.getDate()).toBe(13);
  });
});

describe("custom snooze time", () => {
  it("formats a local wall-clock value without adding a timezone suffix", () => {
    expect(formatSnoozeDateTimeLocal(localDate(2026, 4, 8, 9, 5))).toBe("2026-04-08T09:05");
  });

  it("defaults to at least an hour ahead on a quarter-hour boundary", () => {
    const now = new Date(2026, 3, 8, 10, 7, 59, 999);
    const value = defaultCustomSnoozeDateTime(now);
    const wakeAt = new Date(value);
    expect(wakeAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 60 * 60_000);
    expect(wakeAt.getMinutes() % 15).toBe(0);
  });

  it("keeps the default valid through the repeated hour at the end of DST", () => {
    withTimeZone("America/Los_Angeles", () => {
      const now = new Date("2024-11-03T01:15:30-07:00");
      const value = defaultCustomSnoozeDateTime(now);
      const parsed = parseCustomSnoozeDateTime(value, now);
      expect(parsed).not.toBeNull();
      expect(new Date(parsed!).getTime()).toBeGreaterThanOrEqual(now.getTime() + 60 * 60_000);
    });
  });

  it("converts a future local value to ISO and rejects invalid or past values", () => {
    const now = localDate(2026, 4, 8, 10);
    const future = "2026-04-08T12:30";
    expect(parseCustomSnoozeDateTime(future, now)).toBe(new Date(future).toISOString());
    expect(parseCustomSnoozeDateTime("", now)).toBeNull();
    expect(parseCustomSnoozeDateTime("not-a-date", now)).toBeNull();
    expect(parseCustomSnoozeDateTime("2026-04-08T09:59", now)).toBeNull();
  });

  it("rejects local wall-clock values normalized across a DST gap", () => {
    withTimeZone("America/Los_Angeles", () => {
      const now = new Date("2024-03-10T00:00:00-08:00");
      expect(parseCustomSnoozeDateTime("2024-03-10T02:30", now)).toBeNull();
      expect(parseCustomSnoozeDateTime("2024-03-10T03:30", now)).toBe(
        new Date("2024-03-10T03:30:00-07:00").toISOString(),
      );
    });
  });
});

describe("snoozeWakeLabel", () => {
  const now = localDate(2026, 4, 8, 10);

  it("formats minutes, hours, and days, rounding up", () => {
    expect(snoozeWakeLabel(new Date(now.getTime() + 30 * 60_000).toISOString(), now)).toBe("30m");
    expect(snoozeWakeLabel(new Date(now.getTime() + 90 * 60_000).toISOString(), now)).toBe("2h");
    expect(snoozeWakeLabel(new Date(now.getTime() + 26 * 3_600_000).toISOString(), now)).toBe("2d");
  });

  it("reports now for past and malformed wake times", () => {
    expect(snoozeWakeLabel(new Date(now.getTime() - 1000).toISOString(), now)).toBe("now");
    expect(snoozeWakeLabel("not-a-date", now)).toBe("now");
  });
});

describe("snoozeWakeDescription", () => {
  const now = localDate(2026, 4, 8, 10);

  it("uses bare time today, 'tomorrow' next day, weekday within the week", () => {
    expect(snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now)).not.toContain(
      "tomorrow",
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 9, 9).toISOString(), now)).toContain(
      "tomorrow",
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 13, 9).toISOString(), now)).toMatch(/Mon/);
  });
});
