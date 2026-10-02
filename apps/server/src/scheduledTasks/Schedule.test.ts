import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  isMissedFixedTimeRun,
  isOutsideIntervalRestrictions,
  isSameSchedule,
  nextScheduledRunAt,
  parseTimeOfDay,
} from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("parses 24-hour times", () => {
    expect(parseTimeOfDay("09:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseTimeOfDay("25:00")).toBeNull();
  });

  it("calculates interval schedules from the supplied instant", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 5 * 60_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:05:00.000Z");
  });

  it("clamps legacy sub-minute intervals to the one-minute execution floor", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 1_000 },
      DateTime.makeUnsafe("2026-07-01T16:00:00.000Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-01T16:01:00.000Z");
  });

  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("skips fixed-time runs missed by more than the grace window", () => {
    const fixedTime = { type: "fixed_time", timeOfDay: "09:00" } as const;
    const dueAt = DateTime.makeUnsafe("2026-07-01T09:00:00.000Z");
    const withinGrace = DateTime.makeUnsafe("2026-07-01T09:05:00.000Z");
    const pastGrace = DateTime.makeUnsafe("2026-07-01T15:00:00.000Z");
    // A run only slightly late (poll jitter, short sleep) still fires.
    expect(isMissedFixedTimeRun(fixedTime, dueAt, withinGrace)).toBe(false);
    // A run hours past its slot is skipped and rescheduled instead.
    expect(isMissedFixedTimeRun(fixedTime, dueAt, pastGrace)).toBe(true);
    // Interval schedules always catch up with a single run, never skip.
    expect(isMissedFixedTimeRun({ type: "interval", everyMs: 60_000 }, dueAt, pastGrace)).toBe(
      false,
    );
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    // Weekday masks are sets: order and duplicates do not change firing.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    // Omitted, empty, and all-seven masks all mean daily.
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
    // Window and weekday restrictions participate in schedule equality:
    // changing either must recompute the pending run. The run cap does not
    // change fire times, so editing it leaves the pending run alone.
    const restricted = {
      type: "interval",
      everyMs: 1_800_000,
      weekdays: [1, 2, 3, 4, 5],
      window: { start: "09:00", end: "17:00" },
      maxRuns: 16,
    } as const;
    expect(isSameSchedule(restricted, { ...restricted, weekdays: [5, 4, 3, 2, 1] })).toBe(true);
    expect(
      isSameSchedule(restricted, { ...restricted, window: { start: "9:00", end: "17:00" } }),
    ).toBe(true);
    expect(isSameSchedule(restricted, { ...restricted, maxRuns: 17 })).toBe(true);
    expect(isSameSchedule(restricted, { ...restricted, weekdays: [1, 2, 3, 4] })).toBe(false);
    expect(isSameSchedule(restricted, { ...restricted, window: undefined })).toBe(false);
    expect(isSameSchedule(restricted, { type: "interval", everyMs: 1_800_000 })).toBe(false);
  });

  it.each([
    ["9:00", "09:00"],
    ["09:00", "9:00"],
    ["0:30", "00:30"],
  ])("treats %s and %s as the same fixed-time schedule", (before, after) => {
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: before },
        { type: "fixed_time", timeOfDay: after },
      ),
    ).toBe(true);
  });
});

describe("interval weekday and window restrictions", () => {
  // A Monday, pinned to a fixed zone so window math cannot drift with the
  // machine's locale.
  const mondayMorning = DateTime.makeZonedUnsafe(
    { year: 2026, month: 9, day: 28, hour: 7, minute: 10, second: 0, millisecond: 0 },
    { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
  );
  const fridayLate = DateTime.makeZonedUnsafe(
    { year: 2026, month: 9, day: 25, hour: 23, minute: 40, second: 0, millisecond: 0 },
    { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
  );
  const utc = (value: DateTime.DateTime | null) =>
    value ? DateTime.formatIso(DateTime.toUtc(value)) : null;

  it("keeps unrestricted intervals on their cadence", () => {
    const next = nextScheduledRunAt({ type: "interval", everyMs: 1_800_000 }, mondayMorning);
    expect(utc(next)).toBe(
      DateTime.formatIso(DateTime.toUtc(DateTime.add(mondayMorning, { minutes: 30 }))),
    );
  });

  it("snaps an interval run into the next window opening", () => {
    const nearClose = DateTime.makeZonedUnsafe(
      { year: 2026, month: 9, day: 28, hour: 16, minute: 50, second: 0, millisecond: 0 },
      { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
    );
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 1_800_000, window: { start: "09:00", end: "17:00" } },
      nearClose,
    );
    // 17:20 is past the window close, so the run moves to Tuesday's opening.
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(2);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("fires the first interval run at the window opening from an earlier start", () => {
    const next = nextScheduledRunAt(
      {
        type: "interval",
        everyMs: 1_800_000,
        weekdays: [1, 2, 3, 4, 5],
        window: { start: "09:00", end: "17:00" },
      },
      mondayMorning,
    );
    // 07:40 would be out of hours, so the run opens the window instead.
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("skips disallowed weekdays even without a window", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 1_800_000, weekdays: [1, 2, 3, 4, 5] },
      fridayLate,
    );
    // Friday 23:40 + 30min lands on Saturday; the run moves to Monday 00:00.
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(0);
    expect(parts?.minute).toBe(0);
  });

  it("treats an empty weekday mask as every day", () => {
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 60_000, weekdays: [] },
      fridayLate,
    );
    expect(utc(next)).toBe(
      DateTime.formatIso(DateTime.toUtc(DateTime.add(fridayLate, { minutes: 1 }))),
    );
  });

  it("keeps fixed-time schedules on their weekday cadence", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      fridayLate,
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
  });
});

describe("interval restrictions at dispatch and across DST", () => {
  const zoned = (
    zone: string,
    parts: { year: number; month: number; day: number; hour: number; minute: number },
  ) =>
    DateTime.makeZonedUnsafe(
      { ...parts, second: 0, millisecond: 0 },
      { timeZone: zone, adjustForTimeZone: true },
    );
  const business = {
    type: "interval",
    everyMs: 1_800_000,
    weekdays: [1, 2, 3, 4, 5],
    window: { start: "09:00", end: "17:00" },
  } as const;

  it("flags an overdue interval dispatched after hours or on a weekend", () => {
    const zone = "America/Los_Angeles";
    const at = (day: number, hour: number, minute = 0) =>
      zoned(zone, { year: 2026, month: 9, day, hour, minute });
    expect(isOutsideIntervalRestrictions(business, at(28, 12))).toBe(false);
    expect(isOutsideIntervalRestrictions(business, at(28, 17, 0))).toBe(true);
    expect(isOutsideIntervalRestrictions(business, at(28, 8, 59))).toBe(true);
    expect(isOutsideIntervalRestrictions(business, at(25, 12))).toBe(false);
    expect(isOutsideIntervalRestrictions(business, at(26, 12))).toBe(true);
    expect(isOutsideIntervalRestrictions({ type: "interval", everyMs: 60_000 }, at(27, 3))).toBe(
      false,
    );
    expect(
      isOutsideIntervalRestrictions({ type: "fixed_time", timeOfDay: "09:00" }, at(27, 3)),
    ).toBe(false);
  });

  it("skips a day whose window opening falls in a spring-forward gap", () => {
    // 2026-03-08 02:00-03:00 does not exist in New York.
    const from = zoned("America/New_York", { year: 2026, month: 3, day: 8, hour: 1, minute: 0 });
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 60_000, window: { start: "02:10", end: "02:20" } },
      from,
    );
    expect(next && DateTime.toParts(next)).toMatchObject({ day: 9, hour: 2, minute: 10 });
  });

  it("opens a window at the later 01:30 when a fall-back hour repeats", () => {
    // 2026-11-01 01:00-02:00 occurs twice in New York; 06:05Z is the
    // repeated 01:05 (EST), after the first 01:30 (EDT) has passed.
    const from = DateTime.makeZonedUnsafe("2026-11-01T06:05:00Z", {
      timeZone: "America/New_York",
    });
    expect(DateTime.toParts(from)).toMatchObject({ hour: 1, minute: 5 });
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 15 * 60_000, window: { start: "01:30", end: "03:00" } },
      from,
    );
    expect(next).not.toBeNull();
    expect(next && DateTime.toEpochMillis(next)).toBe(DateTime.toEpochMillis(from) + 25 * 60_000);
  });

  it("uses the repeated window when it closes inside a fall-back hour", () => {
    // 05:40Z is the first 01:40 (EDT), after the first 01:10-01:30 window
    // closed; the same wall-clock window repeats at 06:10Z (EST).
    const from = DateTime.makeZonedUnsafe("2026-11-01T05:40:00Z", {
      timeZone: "America/New_York",
    });
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 60_000, window: { start: "01:10", end: "01:30" } },
      from,
    );
    expect(next && DateTime.formatIso(next)).toBe("2026-11-01T06:10:00.000Z");
  });

  it("re-enters a window that straddles the start of a repeated fall-back hour", () => {
    // 00:30-01:30 closed at the first 01:30 (EDT); the clock re-enters the
    // window when 02:00 EDT falls back to 01:00 EST at 06:00Z.
    const from = DateTime.makeZonedUnsafe("2026-11-01T05:40:00Z", {
      timeZone: "America/New_York",
    });
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 60_000, window: { start: "00:30", end: "01:30" } },
      from,
    );
    expect(next && DateTime.formatIso(next)).toBe("2026-11-01T06:00:00.000Z");
  });

  it("handles a half-hour fall-back when re-entering a window", () => {
    // Lord Howe falls back 30 minutes: 02:00 (+11:00) becomes 01:30 (+10:30)
    // at 2026-04-04T15:00Z, re-entering a 01:00-01:45 window.
    const from = DateTime.makeZonedUnsafe("2026-04-04T14:50:00Z", {
      timeZone: "Australia/Lord_Howe",
    });
    expect(DateTime.toParts(from)).toMatchObject({ hour: 1, minute: 50 });
    const next = nextScheduledRunAt(
      { type: "interval", everyMs: 60_000, window: { start: "01:00", end: "01:45" } },
      from,
    );
    expect(next && DateTime.formatIso(next)).toBe("2026-04-04T15:00:00.000Z");
  });

  it("finds the next Sunday window even when it opens inside a spring-forward gap", () => {
    const from = zoned("America/New_York", { year: 2026, month: 3, day: 1, hour: 5, minute: 0 });
    const next = nextScheduledRunAt(
      {
        type: "interval",
        everyMs: 1_800_000,
        weekdays: [0],
        window: { start: "02:30", end: "04:00" },
      },
      from,
    );
    expect(next).not.toBeNull();
  });
});
