import { describe, expect, it } from "vite-plus/test";

import {
  formatSnoozeForInput,
  parseSnoozeForInput,
  resolveSnoozePresets,
  snoozeWakeDescription,
} from "./Sidebar.snooze";

// Local-time constructor so preset math is timezone-stable in tests.
function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("resolveSnoozePresets", () => {
  it("offers one hour, three hours, evening, tomorrow, and next week in the morning", () => {
    // Wednesday 2026-04-08 10:00 local.
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), "locale");
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    const threeHours = presets.find((preset) => preset.id === "three-hours");
    expect(new Date(threeHours!.snoozedUntil).getHours()).toBe(13);
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
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), "locale");
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
    expect(
      resolveSnoozePresets(localDate(2026, 4, 8, 17, 30), "locale").map((preset) => preset.id),
    ).toEqual(["hour", "three-hours", "tomorrow", "next-week"]);
    expect(
      resolveSnoozePresets(localDate(2026, 4, 8, 21), "locale").map((preset) => preset.id),
    ).toEqual(["hour", "three-hours", "tomorrow", "next-week"]);
  });

  it("puts next week a full week out when today is Monday", () => {
    // Monday 2026-04-06.
    const presets = resolveSnoozePresets(localDate(2026, 4, 6, 10), "locale");
    const nextWeek = new Date(presets.find((preset) => preset.id === "next-week")!.snoozedUntil);
    expect(nextWeek.getDay()).toBe(1);
    expect(nextWeek.getDate()).toBe(13);
  });
  it("formats preset times with the selected clock preference", () => {
    const twelveHour = resolveSnoozePresets(localDate(2026, 4, 8, 10), "12-hour");
    const twentyFourHour = resolveSnoozePresets(localDate(2026, 4, 8, 10), "24-hour");

    expect(twelveHour.find((preset) => preset.id === "evening")!.whenLabel).toMatch(/PM/i);
    expect(twentyFourHour.find((preset) => preset.id === "evening")!.whenLabel).toBe("18:00");
  });
});

describe("snoozeWakeDescription", () => {
  const now = localDate(2026, 4, 8, 10);

  it("uses bare time today, 'tomorrow' next day, weekday within the week", () => {
    expect(
      snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "locale"),
    ).not.toContain("tomorrow");
    expect(snoozeWakeDescription(localDate(2026, 4, 9, 9).toISOString(), now, "locale")).toContain(
      "tomorrow",
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 13, 9).toISOString(), now, "locale")).toMatch(
      /Mon/,
    );
  });

  it("formats wake descriptions with the selected clock preference", () => {
    expect(snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "12-hour")).toMatch(
      /PM/i,
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "24-hour")).toBe(
      "18:00",
    );
  });
});

describe("custom snooze browser input", () => {
  it("round-trips local date and time without applying a UTC offset", () => {
    const value = localDate(2026, 4, 8, 13, 45);
    const input = formatSnoozeForInput(value);
    const parsed = parseSnoozeForInput(input, { now: localDate(2026, 4, 8, 10) });

    expect(input).toBe("2026-04-08T13:45");
    expect(parsed).toEqual({ ok: true, value });
  });

  it("round-trips dates with more than four year digits", () => {
    const value = localDate(10_000, 1, 1, 13, 45);
    const input = formatSnoozeForInput(value);

    expect(input).toBe("10000-01-01T13:45");
    expect(parseSnoozeForInput(input, { now: localDate(9_999, 12, 31, 0) })).toEqual({
      ok: true,
      value,
    });
  });

  it("rejects malformed, normalized, and expired local values", () => {
    const now = localDate(2026, 4, 8, 10);

    expect(parseSnoozeForInput("", { now })).toEqual({
      ok: false,
      error: "Choose a valid date and time.",
    });
    expect(parseSnoozeForInput("2026-02-30T11:00", { now })).toEqual({
      ok: false,
      error: "Choose a valid date and time.",
    });
    expect(parseSnoozeForInput("2026-04-08T09:00", { now })).toEqual({
      ok: false,
      error: "Choose a time in the future.",
    });
  });

  it("rejects a local wall time normalized through a daylight-saving gap", () => {
    const normalized = localDate(2026, 3, 8, 2, 30);
    // UTC and zones without a March DST transition have no gap to exercise.
    if (normalized.getHours() === 2 && normalized.getMinutes() === 30) return;

    expect(parseSnoozeForInput("2026-03-08T02:30", { now: localDate(2026, 3, 7, 12) })).toEqual({
      ok: false,
      error: "Choose a valid date and time.",
    });
  });

  it("chooses the future occurrence of a repeated local hour", () => {
    const firstOccurrence = localDate(2026, 11, 1, 1, 30);
    const secondOccurrence = new Date(firstOccurrence.getTime() + 60 * 60 * 1_000);
    // UTC and zones without a one-hour November fallback have no repeat.
    if (formatSnoozeForInput(secondOccurrence) !== "2026-11-01T01:30") return;

    expect(
      parseSnoozeForInput("2026-11-01T01:30", {
        now: new Date(firstOccurrence.getTime() + 30 * 60 * 1_000),
      }),
    ).toEqual({ ok: true, value: secondOccurrence });
  });

  it("supports repeated local times from a 30-minute fallback", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "Australia/Lord_Howe";
      const firstOccurrence = localDate(2026, 4, 5, 1, 45);
      const secondOccurrence = new Date(firstOccurrence.getTime() + 30 * 60 * 1_000);

      expect(formatSnoozeForInput(secondOccurrence)).toBe("2026-04-05T01:45");
      expect(
        parseSnoozeForInput("2026-04-05T01:45", {
          now: new Date(firstOccurrence.getTime() + 15 * 60 * 1_000),
        }),
      ).toEqual({ ok: true, value: secondOccurrence });
    } finally {
      process.env.TZ = originalTimezone;
    }
  });
});
