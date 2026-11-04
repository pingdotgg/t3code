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

  it("accepts an interval window and rejects an inverted or invalid one", () => {
    const window = { start: "9:00", end: "10:00", weekdays: [1, 1, 5] };
    const schedule = { type: "interval" as const, everyMs: 60_000, window };
    expect(decodeSchedule(schedule)).toEqual(schedule);
    expect(decodeUpsertSchedule(schedule)).toEqual(schedule);
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
        window: { start: "9:00", end: "10:00" },
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      window: { start: "9:00", end: "10:00" },
    });

    const daily = {
      type: "interval",
      everyMs: 60_000,
      window: { start: "10:00", end: "20:00", weekdays: [] },
    };
    expect(decodeSchedule(daily)).toEqual(daily);
    expect(decodeUpsertSchedule(daily)).toEqual(daily);

    for (const decode of [decodeSchedule, decodeUpsertSchedule]) {
      expect(() =>
        decode({ type: "interval", everyMs: 60_000, window: { start: "10:00", end: "9:00" } }),
      ).toThrow();
      expect(() =>
        decode({ type: "interval", everyMs: 60_000, window: { start: "10:00", end: "10:00" } }),
      ).toThrow();
      for (const weekdays of [[7], [-1], [1.5]]) {
        expect(() =>
          decode({
            type: "interval",
            everyMs: 60_000,
            window: { start: "10:00", end: "20:00", weekdays },
          }),
        ).toThrow();
      }
    }
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});
