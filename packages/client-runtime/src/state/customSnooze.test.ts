// @effect-diagnostics globalDate:off -- Tests exercise local calendar and elapsed-time snooze input.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  addSnoozeFavorite,
  localSnoozeDate,
  localSnoozeTime,
  MAX_SNOOZE_FAVORITES,
  removeSnoozeFavorite,
  resolveCustomSnooze,
  resolveSnoozeFavoritePresets,
  snoozeFavoriteLabel,
} from "./threadSettled.ts";

const now = new Date(2026, 8, 14, 14, 30);

afterEach(() => vi.unstubAllEnvs());

describe("custom snooze", () => {
  it("converts local date and time to an absolute wake time", () => {
    expect(resolveCustomSnooze({ mode: "date", date: "2026-09-15", time: "09:15" }, now)).toBe(
      new Date(2026, 8, 15, 9, 15).toISOString(),
    );
  });

  it.each([
    ["2026-09-14", "14:30"],
    ["2026-09-13", "09:00"],
    ["2027-02-29", "09:00"],
    ["2026-13-01", "09:00"],
    ["2026-09-15", "24:00"],
    ["2026-09-15", "09:60"],
    ["", "09:00"],
    ["2026-09-15", ""],
  ])("rejects invalid or non-future calendar input %s %s", (date, time) => {
    expect(resolveCustomSnooze({ mode: "date", date, time }, now)).toBeNull();
  });

  it.each([
    ["minutes", "45", 45 * 60_000],
    ["hours", "1.5", 90 * 60_000],
    ["days", "2", 48 * 3_600_000],
  ] as const)("resolves %s from the confirmation time", (unit, amount, elapsed) => {
    const confirmedAt = new Date(now.getTime() + 5 * 60_000);
    expect(resolveCustomSnooze({ mode: "duration", amount, unit }, confirmedAt)).toBe(
      new Date(confirmedAt.getTime() + elapsed).toISOString(),
    );
  });

  it.each(["", "0", "-1", "NaN", "Infinity", "1e300"])("rejects invalid duration %s", (amount) => {
    expect(resolveCustomSnooze({ mode: "duration", amount, unit: "hours" }, now)).toBeNull();
  });

  it("rejects nonexistent local times at the spring DST transition", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      resolveCustomSnooze(
        { mode: "date", date: "2027-03-14", time: "02:30" },
        new Date("2027-03-01T00:00:00Z"),
      ),
    ).toBeNull();
  });

  it("treats duration days as 24 hours across DST", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const before = new Date(2027, 2, 13, 12);
    const wake = resolveCustomSnooze({ mode: "duration", amount: "1", unit: "days" }, before);
    expect(wake).toBe(new Date(2027, 2, 14, 13).toISOString());
  });

  it("formats local input values without converting to UTC", () => {
    const date = new Date(2026, 0, 2, 3, 4);
    expect(localSnoozeDate(date)).toBe("2026-01-02");
    expect(localSnoozeTime(date)).toBe("03:04");
  });
});

describe("snooze favorites", () => {
  it("labels durations with a singular unit for one", () => {
    expect(snoozeFavoriteLabel({ amount: 1, unit: "days" })).toBe("1 day");
    expect(snoozeFavoriteLabel({ amount: 1.5, unit: "hours" })).toBe("1.5 hours");
    expect(snoozeFavoriteLabel({ amount: 45, unit: "minutes" })).toBe("45 minutes");
  });

  it("resolves favorites relative to the menu opening time", () => {
    const [preset] = resolveSnoozeFavoritePresets([{ amount: 2, unit: "hours" }], now);
    expect(preset).toMatchObject({
      id: "favorite:2-hours",
      label: "In 2 hours",
      snoozedUntil: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    });
  });

  it("skips favorites whose wake time overflows instead of throwing", () => {
    expect(
      resolveSnoozeFavoritePresets(
        [
          { amount: 1e300, unit: "hours" },
          { amount: 2, unit: "hours" },
        ],
        now,
      ).map((preset) => preset.id),
    ).toEqual(["favorite:2-hours"]);
    const maxDate = new Date(8.64e15);
    const justBefore = new Date(maxDate.getTime() - 60_000);
    expect(resolveSnoozeFavoritePresets([{ amount: 2, unit: "minutes" }], justBefore)).toEqual([]);
  });

  it("ignores duplicates, drops the oldest past the cap, and removes by value", () => {
    const two = { amount: 2, unit: "hours" } as const;
    const list = addSnoozeFavorite([], two);
    expect(addSnoozeFavorite(list, { ...two })).toBe(list);
    let full = list;
    for (let minutes = 1; minutes <= MAX_SNOOZE_FAVORITES; minutes += 1) {
      full = addSnoozeFavorite(full, { amount: minutes, unit: "minutes" });
    }
    expect(full).toHaveLength(MAX_SNOOZE_FAVORITES);
    expect(full).not.toContainEqual(two);
    expect(removeSnoozeFavorite(full, { amount: 1, unit: "minutes" })).toHaveLength(
      MAX_SNOOZE_FAVORITES - 1,
    );
  });
});
