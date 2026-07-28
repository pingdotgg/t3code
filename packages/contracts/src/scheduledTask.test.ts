import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { MIN_SCHEDULED_TASK_INTERVAL_MS, ScheduledTaskSchedule } from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);

describe("ScheduledTaskSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeSchedule({
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
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});
