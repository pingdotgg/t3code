import { describe, expect, it } from "@effect/vitest";
import type { ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

const SOFIA = "Europe/Sofia";

function sofia(year: number, month: number, day: number, hour = 9, minute = 0) {
  return DateTime.makeZonedUnsafe(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { timeZone: SOFIA, adjustForTimeZone: true },
  );
}

function localLabel(value: DateTime.DateTime): string {
  const parts = DateTime.toParts(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function upcomingRuns(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
  count: number,
): ReadonlyArray<string> {
  const runs: string[] = [];
  let cursor = from;
  while (runs.length < count) {
    const next = nextScheduledRunAt(schedule, cursor);
    if (next === null) break;
    runs.push(localLabel(next));
    cursor = next;
  }
  return runs;
}

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

  it("runs on the chosen days of every month", () => {
    expect(
      upcomingRuns(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [6, 4] },
        sofia(2026, 10, 19, 10),
        4,
      ),
    ).toEqual(["2026-11-04 09:00", "2026-11-06 09:00", "2026-12-04 09:00", "2026-12-06 09:00"]);
  });

  it("runs a day a month doesn't have on that month's last day", () => {
    expect(
      upcomingRuns(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [31] },
        sofia(2026, 1, 31, 10),
        5,
      ),
    ).toEqual([
      "2026-02-28 09:00",
      "2026-03-31 09:00",
      "2026-04-30 09:00",
      "2026-05-31 09:00",
      "2026-06-30 09:00",
    ]);
    // The 30th and the 31st share April's last day, so April runs once.
    expect(
      upcomingRuns(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [30, 31] },
        sofia(2026, 4, 1),
        3,
      ),
    ).toEqual(["2026-04-30 09:00", "2026-05-30 09:00", "2026-05-31 09:00"]);
  });

  it("runs on 29 February in leap years and on the 28th otherwise", () => {
    expect(
      upcomingRuns(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [29], months: [2] },
        sofia(2026, 1, 1),
        3,
      ),
    ).toEqual(["2026-02-28 09:00", "2027-02-28 09:00", "2028-02-29 09:00"]);
  });

  it("limits runs to the chosen months across a year boundary", () => {
    expect(
      upcomingRuns(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [5], months: [1, 4, 7, 10] },
        sofia(2026, 10, 19, 10),
        4,
      ),
    ).toEqual(["2027-01-05 09:00", "2027-04-05 09:00", "2027-07-05 09:00", "2027-10-05 09:00"]);
    expect(
      upcomingRuns(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1], months: [1] },
        sofia(2026, 2, 1),
        2,
      ),
    ).toEqual(["2027-01-04 09:00", "2027-01-11 09:00"]);
  });

  it("keeps a monthly run on local wall-clock time across a daylight-saving change", () => {
    const schedule = { type: "fixed_time", timeOfDay: "09:00", monthDays: [4] } as const;
    const october = nextScheduledRunAt(schedule, sofia(2026, 10, 1));
    const november = october === null ? null : nextScheduledRunAt(schedule, october);
    // Sofia leaves summer time (UTC+3) for UTC+2 on 25 October.
    expect(october ? DateTime.formatIso(DateTime.toUtc(october)) : null).toBe(
      "2026-10-04T06:00:00.000Z",
    );
    expect(november ? DateTime.formatIso(DateTime.toUtc(november)) : null).toBe(
      "2026-11-04T07:00:00.000Z",
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

  it("compares month-day and month selections structurally", () => {
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [6, 4, 4], months: [10, 1] },
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [4, 6], months: [1, 10] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        {
          type: "fixed_time",
          timeOfDay: "09:00",
          monthDays: Array.from({ length: 31 }, (_, index) => index + 1),
          months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [4] },
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [5] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [5] },
        { type: "fixed_time", timeOfDay: "09:00", monthDays: [5], months: [1, 4, 7, 10] },
      ),
    ).toBe(false);
  });
});
