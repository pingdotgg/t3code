import { describe, expect, it } from "vite-plus/test";
import { formatScheduledTaskInterval } from "./scheduledTaskInterval.ts";

const MINUTE = 60_000;

describe("formatScheduledTaskInterval", () => {
  it.each([
    [1, "Every minute"],
    [15, "Every 15 minutes"],
    [60, "Every hour"],
    [90, "Every 1 hour and 30 minutes"],
    [120, "Every 2 hours"],
    [1440, "Every day"],
    [1500, "Every 25 hours"],
    [1501, "Every 25 hours and 1 minute"],
    [2880, "Every 2 days"],
    [2940, "Every 49 hours"],
    [10080, "Every week"],
    [11520, "Every 8 days"],
    [20160, "Every 2 weeks"],
  ])("formats a %i-minute interval as %s", (minutes, expected) => {
    expect(formatScheduledTaskInterval(minutes * MINUTE)).toBe(expected);
  });

  it("retains precision for legacy sub-minute schedules", () => {
    expect(formatScheduledTaskInterval(30_000)).toBe("Every 30 seconds");
    expect(formatScheduledTaskInterval(90_000)).toBe("Every 1 minute and 30 seconds");
    expect(formatScheduledTaskInterval(1)).toBe("Every millisecond");
    expect(formatScheduledTaskInterval(1_500)).toBe("Every 1 second and 500 milliseconds");
  });

  it("joins mixed units in readable order without rounding", () => {
    expect(formatScheduledTaskInterval(3_661_000)).toBe("Every 1 hour, 1 minute and 1 second");
    expect(formatScheduledTaskInterval(90_061_000)).toBe("Every 25 hours, 1 minute and 1 second");
  });
});
