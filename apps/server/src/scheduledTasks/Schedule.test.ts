import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isMissedScheduledRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  function local(day: number, hour: number, minute: number) {
    return DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day, hour, minute, second: 0, millisecond: 0 },
      { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
    );
  }

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

  it.each([
    {
      name: "resumes the next morning after an evening run",
      from: [6, 19, 30] as const,
      everyMs: 3_600_000,
      weekdays: undefined,
      day: 7,
      hour: 10,
      weekDay: 2,
    },
    {
      name: "keeps the next interval when it is still inside the window",
      from: [6, 15, 0] as const,
      everyMs: 3_600_000,
      weekdays: undefined,
      day: 6,
      hour: 16,
      weekDay: 1,
    },
    {
      name: "treats the window start as inside",
      from: [6, 9, 0] as const,
      everyMs: 3_600_000,
      weekdays: undefined,
      day: 6,
      hour: 10,
      weekDay: 1,
    },
    {
      name: "waits for the next allowed weekday",
      from: [5, 23, 0] as const,
      everyMs: 3_600_000,
      weekdays: [1, 2, 3, 4, 5],
      day: 6,
      hour: 10,
      weekDay: 1,
    },
    {
      name: "treats the window end as outside",
      from: [6, 19, 0] as const,
      everyMs: 3_600_000,
      weekdays: undefined,
      day: 7,
      hour: 10,
      weekDay: 2,
    },
    {
      name: "starts the open window when the interval lands past it",
      from: [6, 9, 0] as const,
      everyMs: 12 * 3_600_000,
      weekdays: undefined,
      day: 6,
      hour: 10,
      weekDay: 1,
    },
    {
      name: "skips a weekend between windows",
      from: [3, 19, 30] as const,
      everyMs: 3_600_000,
      weekdays: [1, 2, 3, 4, 5],
      day: 6,
      hour: 10,
      weekDay: 1,
    },
    {
      name: "treats an empty weekday list as every day",
      from: [4, 15, 0] as const,
      everyMs: 3_600_000,
      weekdays: [],
      day: 4,
      hour: 16,
      weekDay: 6,
    },
  ])("$name", ({ from, everyMs, weekdays, day, hour, weekDay }) => {
    const next = nextScheduledRunAt(
      {
        type: "interval",
        everyMs,
        window: {
          start: "10:00",
          end: "20:00",
          ...(weekdays === undefined ? {} : { weekdays }),
        },
      },
      local(from[0], from[1], from[2]),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts && [parts.day, parts.hour, parts.minute, parts.weekDay]).toEqual([
      day,
      hour,
      0,
      weekDay,
    ]);
  });

  it("advances an interval without a window by everyMs", () => {
    const from = local(6, 15, 0);
    const next = nextScheduledRunAt({ type: "interval", everyMs: 3_600_000 }, from);
    expect(next && DateTime.toEpochMillis(next) - DateTime.toEpochMillis(from)).toBe(3_600_000);
  });

  it("uses the later copy of a window start when clocks fall back", () => {
    const next = nextScheduledRunAt(
      {
        type: "interval",
        everyMs: 3_600_000,
        window: { start: "01:30", end: "01:45" },
      },
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 50, second: 0, millisecond: 0 },
        { timeZone: "America/New_York", adjustForTimeZone: true },
      ),
    );
    expect(next && DateTime.formatIso(next)).toBe("2026-11-01T06:30:00.000Z");
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts && [parts.month, parts.day, parts.hour, parts.minute]).toEqual([11, 1, 1, 30]);
    const halfHour = nextScheduledRunAt(
      { type: "interval", everyMs: 3_600_000, window: { start: "01:35", end: "01:45" } },
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 4, day: 5, hour: 1, minute: 50 },
        { timeZone: "Australia/Lord_Howe", adjustForTimeZone: true },
      ),
    );
    expect(halfHour && DateTime.formatIso(halfHour)).toBe("2026-04-04T15:05:00.000Z");
  });

  it("skips a due windowed interval once the window has closed", () => {
    const dueAt = local(6, 19, 30);
    const schedule = {
      type: "interval" as const,
      everyMs: 3_600_000,
      window: { start: "10:00", end: "20:00" },
    };
    expect(isMissedScheduledRun(schedule, dueAt, local(6, 19, 50))).toBe(false);
    expect(isMissedScheduledRun(schedule, dueAt, local(6, 21, 0))).toBe(true);
    expect(isMissedScheduledRun(schedule, dueAt, local(7, 10, 30))).toBe(true);
    expect(
      isMissedScheduledRun({ type: "interval", everyMs: 3_600_000 }, dueAt, local(6, 21, 0)),
    ).toBe(false);
  });

  it("skips a window start that daylight saving shifts past the end", () => {
    const next = nextScheduledRunAt(
      {
        type: "interval",
        everyMs: 60_000,
        window: { start: "02:30", end: "03:00" },
      },
      DateTime.makeZonedUnsafe(
        { year: 2025, month: 3, day: 8, hour: 12, minute: 0, second: 0, millisecond: 0 },
        { timeZone: "America/New_York", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts && [parts.month, parts.day, parts.hour, parts.minute]).toEqual([3, 10, 2, 30]);
  });

  it("keeps the next weekly start after daylight saving skips one", () => {
    const next = nextScheduledRunAt(
      {
        type: "interval",
        everyMs: 60_000,
        window: { start: "02:30", end: "03:00", weekdays: [0] },
      },
      DateTime.makeZonedUnsafe(
        { year: 2025, month: 3, day: 2, hour: 2, minute: 59, second: 0, millisecond: 0 },
        { timeZone: "America/New_York", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts && [parts.month, parts.day, parts.hour, parts.minute]).toEqual([3, 16, 2, 30]);
  });

  it("returns null when no weekday can match", () => {
    const next = nextScheduledRunAt(
      {
        type: "interval",
        everyMs: 3_600_000,
        window: { start: "10:00", end: "20:00", weekdays: [9] },
      },
      local(6, 15, 0),
    );
    expect(next).toBeNull();
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
        {
          type: "interval",
          everyMs: 60_000,
          window: { start: "09:00", end: "17:30", weekdays: [1, 5] },
        },
        {
          type: "interval",
          everyMs: 60_000,
          window: { start: "9:00", end: "17:30", weekdays: [5, 1, 1] },
        },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000, window: { start: "9:00", end: "09:30" } },
        { type: "interval", everyMs: 60_000, window: { start: "09:00", end: "9:30" } },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000, window: { start: "09:00", end: "17:00" } },
        {
          type: "interval",
          everyMs: 60_000,
          window: { start: "09:00", end: "17:00", weekdays: [] },
        },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000, window: { start: "09:00", end: "17:00" } },
        {
          type: "interval",
          everyMs: 60_000,
          window: { start: "09:00", end: "17:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
        },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000, window: { start: "09:00", end: "17:00" } },
        { type: "interval", everyMs: 60_000, window: { start: "09:00", end: "18:00" } },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        {
          type: "interval",
          everyMs: 60_000,
          window: { start: "09:00", end: "17:00", weekdays: [1, 2] },
        },
        {
          type: "interval",
          everyMs: 60_000,
          window: { start: "09:00", end: "17:00", weekdays: [1, 3] },
        },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "interval", everyMs: 60_000, window: { start: "09:00", end: "17:00" } },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000, window: { start: "09:00", end: "17:00" } },
        { type: "interval", everyMs: 120_000, window: { start: "09:00", end: "17:00" } },
      ),
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
