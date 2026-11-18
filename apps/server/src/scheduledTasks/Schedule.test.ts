import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isMissedClockTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
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

  describe("cron", () => {
    const BUSINESS_HOURS = { type: "cron", expression: "*/30 9-16 * * MON-FRI" } as const;
    // A zone other than the developer's, so a fallback to host time shows.
    const berlin = (month: number, day: number, hour: number, minute: number) =>
      DateTime.makeZonedUnsafe(
        { year: 2026, month, day, hour, minute, second: 0, millisecond: 0 },
        { timeZone: "Europe/Berlin", adjustForTimeZone: true },
      );
    const nov = (day: number, hour: number, minute: number) => berlin(11, day, hour, minute);
    const nextIn = (from: DateTime.DateTime, schedule = BUSINESS_HOURS) => {
      const next = nextScheduledRunAt(schedule, from);
      if (next === null) return null;
      // A UTC result formats with Z, so a dropped zone fails the comparison.
      return DateTime.isZoned(next) ? DateTime.formatIsoZoned(next) : DateTime.formatIso(next);
    };

    it("runs on the next slot inside the window, in the caller's zone", () => {
      // Thursday 2026-11-05 10:07 → 10:30 the same day.
      expect(nextIn(nov(5, 10, 7))).toBe("2026-11-05T10:30:00.000+01:00[Europe/Berlin]");
      // A due slot is not the next one.
      expect(nextIn(nov(5, 10, 30))).toBe("2026-11-05T11:00:00.000+01:00[Europe/Berlin]");
    });

    it("skips nights and weekends", () => {
      // Thursday after the last slot → Friday 09:00.
      expect(nextIn(nov(5, 16, 30))).toBe("2026-11-06T09:00:00.000+01:00[Europe/Berlin]");
      // Friday after the last slot → Monday 09:00.
      expect(nextIn(nov(6, 16, 45))).toBe("2026-11-09T09:00:00.000+01:00[Europe/Berlin]");
    });

    it("keeps wall-clock time across a daylight-saving change", () => {
      // Clocks fall back on Sunday 2026-10-25; Friday is +02:00, Monday is +01:00.
      expect(nextIn(berlin(10, 23, 16, 30))).toBe("2026-10-26T09:00:00.000+01:00[Europe/Berlin]");
    });

    it("has no next run for an expression that does not parse", () => {
      expect(nextIn(nov(5, 10, 0), { type: "cron", expression: "0 9 * *" } as never)).toBe(null);
    });

    it("treats equivalent expressions as the same schedule", () => {
      expect(
        isSameSchedule(BUSINESS_HOURS, { type: "cron", expression: "0,30 9-16 * * 1-5" }),
      ).toBe(true);
      expect(
        isSameSchedule(BUSINESS_HOURS, { type: "cron", expression: "*/30 9-17 * * 1-5" }),
      ).toBe(false);
      expect(isSameSchedule(BUSINESS_HOURS, { type: "fixed_time", timeOfDay: "09:00" })).toBe(
        false,
      );
    });

    it("skips a run found well after its time, like fixed-time tasks", () => {
      const dueAt = nov(5, 10, 0);
      expect(isMissedClockTimeRun(BUSINESS_HOURS, dueAt, nov(5, 10, 10))).toBe(false);
      expect(isMissedClockTimeRun(BUSINESS_HOURS, dueAt, nov(5, 10, 11))).toBe(true);
      expect(
        isMissedClockTimeRun({ type: "interval", everyMs: 60_000 }, dueAt, nov(5, 11, 0)),
      ).toBe(false);
    });
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
        { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
      ),
    ).toBe(true);
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
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
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
  });
});
