import { describe, expect, it } from "vite-plus/test";

import { resolveSnoozePresets, snoozeWakeDescription, snoozeWakeLabel } from "./Sidebar.snooze";

// Local-time constructor so preset math is timezone-stable in tests.
function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
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
