import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });

  it("reads persisted interval restrictions", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: 1_800_000,
        weekdays: [1, 2, 3, 4, 5],
        window: { start: "09:00", end: "17:00" },
        maxRuns: 16,
      }),
    ).toEqual({
      type: "interval",
      everyMs: 1_800_000,
      weekdays: [1, 2, 3, 4, 5],
      window: { start: "09:00", end: "17:00" },
      maxRuns: 16,
    });
  });

  it("rejects a window whose start is not before its end", () => {
    expect(() =>
      decodeSchedule({
        type: "interval",
        everyMs: 1_800_000,
        window: { start: "17:00", end: "09:00" },
      }),
    ).toThrow();
    expect(() =>
      decodeSchedule({
        type: "interval",
        everyMs: 1_800_000,
        window: { start: "09:00", end: "09:00" },
      }),
    ).toThrow();
  });

  it("rejects non-positive run caps", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 60_000, maxRuns: 0 })).toThrow();
    expect(() => decodeSchedule({ type: "fixed_time", timeOfDay: "09:00", maxRuns: -1 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });

  it("accepts the business-hours interval shape end to end", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: 1_800_000,
        weekdays: [1, 2, 3, 4, 5],
        window: { start: "9:00", end: "17:00" },
        maxRuns: 16,
      }),
    ).toEqual({
      type: "interval",
      everyMs: 1_800_000,
      weekdays: [1, 2, 3, 4, 5],
      window: { start: "9:00", end: "17:00" },
      maxRuns: 16,
    });
  });

  it("accepts a run cap on fixed-time schedules", () => {
    expect(decodeUpsertSchedule({ type: "fixed_time", timeOfDay: "09:00", maxRuns: 5 })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
      maxRuns: 5,
    });
  });
});
