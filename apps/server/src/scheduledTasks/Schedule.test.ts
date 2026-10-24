import { describe, expect, it } from "@effect/vitest";
import type { ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

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

  describe("fixed time in a time zone", () => {
    const next = (
      schedule: Partial<Extract<ScheduledTaskSchedule, { type: "fixed_time" }>>,
      from: string,
    ) => {
      const run = nextScheduledRunAt(
        { type: "fixed_time", timeOfDay: "09:00", timeZone: "America/Chicago", ...schedule },
        DateTime.makeUnsafe(from),
      );
      return run === null ? null : DateTime.formatIso(DateTime.toUtc(run));
    };

    it("runs at the wall-clock time of its zone, not the server's", () => {
      expect(next({}, "2026-07-03T10:00:00.000Z")).toBe("2026-07-03T14:00:00.000Z");
      expect(next({ timeZone: "Asia/Tokyo" }, "2026-07-03T10:00:00.000Z")).toBe(
        "2026-07-04T00:00:00.000Z",
      );
    });

    it("keeps the wall-clock time across the spring-forward change", () => {
      // 09:00 CST is 15:00Z; after clocks move forward on March 8, 09:00 CDT is 14:00Z.
      expect(next({}, "2026-03-07T16:00:00.000Z")).toBe("2026-03-08T14:00:00.000Z");
      // 02:30 does not exist on March 8, so that run moves to 03:30 CDT.
      expect(next({ timeOfDay: "02:30" }, "2026-03-08T07:00:00.000Z")).toBe(
        "2026-03-08T08:30:00.000Z",
      );
      expect(next({ timeOfDay: "02:30" }, "2026-03-08T08:31:00.000Z")).toBe(
        "2026-03-09T07:30:00.000Z",
      );
      // Lord Howe Island moves forward 30 minutes on October 4, so 02:15 runs at 02:45.
      expect(
        next({ timeOfDay: "02:15", timeZone: "Australia/Lord_Howe" }, "2026-10-03T14:00:00.000Z"),
      ).toBe("2026-10-03T15:45:00.000Z");
    });

    it("keeps the wall-clock time across the fall-back change and runs a repeated time once", () => {
      // 09:00 CDT is 14:00Z; after clocks move back on November 1, 09:00 CST is 15:00Z.
      expect(next({}, "2026-10-31T15:00:00.000Z")).toBe("2026-11-01T15:00:00.000Z");
      // 01:30 happens twice on November 1: first in CDT (06:30Z), then in CST (07:30Z).
      expect(next({ timeOfDay: "01:30" }, "2026-11-01T05:00:00.000Z")).toBe(
        "2026-11-01T06:30:00.000Z",
      );
      expect(next({ timeOfDay: "01:30" }, "2026-11-01T06:31:00.000Z")).toBe(
        "2026-11-02T07:30:00.000Z",
      );
    });

    it("applies weekdays in the zone's calendar", () => {
      // Friday 20:00 in Chicago is already Saturday in UTC.
      expect(next({ timeOfDay: "20:00", weekdays: [5] }, "2026-07-03T12:00:00.000Z")).toBe(
        "2026-07-04T01:00:00.000Z",
      );
    });

    it("has no next run for a zone this runtime does not know", () => {
      expect(next({ timeZone: "Mars/Olympus_Mons" }, "2026-07-03T10:00:00.000Z")).toBeNull();
    });
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
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", timeZone: "America/Chicago" },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
