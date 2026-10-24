import { describe, expect, it } from "vite-plus/test";

import { resolveSnoozePresets } from "./Sidebar.snooze";

function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("resolveSnoozePresets", () => {
  it("keeps the built-in presets in order and adds favorites after them, soonest first", () => {
    // Wednesday 2026-04-08 10:00 local.
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), "locale", [
      { amount: 2, unit: "days" },
      { amount: 2, unit: "hours" },
    ]);
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
      "favorite:2-hours",
      "favorite:2-days",
    ]);
    const twoHours = presets.find((preset) => preset.id === "favorite:2-hours");
    expect(twoHours).toMatchObject({ label: "In 2 hours" });
    expect(new Date(twoHours!.snoozedUntil).getHours()).toBe(12);
    expect(twoHours!.whenLabel).not.toBe("");
    // Same-day wakes show only the time; a favorite on another day names it.
    const weekday = (preset: { snoozedUntil: string }) =>
      new Date(preset.snoozedUntil).toLocaleDateString(undefined, { weekday: "short" });
    const twoDays = presets.find((preset) => preset.id === "favorite:2-days");
    expect(twoHours!.whenLabel).not.toContain(weekday(twoHours!));
    expect(twoDays!.whenLabel.startsWith(weekday(twoDays!))).toBe(true);
  });
});
