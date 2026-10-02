import { describe, expect, it } from "vite-plus/test";
import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

const MINUTE = 60_000;
const now = new Date(2026, 8, 17, 9).getTime();
const timeLabel = (date: Date) =>
  date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

describe("formatScheduledTaskInterval", () => {
  it.each([
    [1, "Every minute"],
    [15, "Every 15 minutes"],
    [60, "Every hour"],
    [90, "Every 1 hour 30 minutes"],
    [120, "Every 2 hours"],
    [1440, "Every day"],
    [1500, "Every 1 day 1 hour"],
    [2880, "Every 2 days"],
    [10080, "Every week"],
  ])("formats a %i-minute interval as %s", (minutes, expected) => {
    expect(formatScheduledTaskInterval(minutes * MINUTE)).toBe(expected);
  });

  it("retains precision for legacy sub-minute schedules", () => {
    expect(formatScheduledTaskInterval(30_000)).toBe("Every 30 seconds");
    expect(formatScheduledTaskInterval(90_000)).toBe("Every 1 minute 30 seconds");
  });
});

describe("formatNextScheduledTaskRun", () => {
  it.each([
    [30_000, "Next run in less than a minute"],
    [MINUTE, "Next run in 1 minute"],
    [15 * MINUTE, "Next run in 15 minutes"],
    [60 * MINUTE, "Next run in 1 hour"],
    [120 * MINUTE, "Next run in 2 hours"],
    [0, "Next run due"],
    [-MINUTE, "Next run due"],
  ])("formats a nearby run %i ms away", (offset, expected) => {
    expect(formatNextScheduledTaskRun(new Date(now + offset).toISOString(), now)).toBe(expected);
  });

  it("uses tomorrow by calendar date, including runs just across midnight", () => {
    const current = new Date(2026, 8, 17, 23, 50);
    const next = new Date(2026, 8, 18, 0, 10);
    expect(formatNextScheduledTaskRun(next.toISOString(), current.getTime())).toBe(
      `Next run tomorrow at ${timeLabel(next)}`,
    );
  });

  it("uses the next weekday within a week", () => {
    const next = new Date(2026, 8, 21, 14, 30);
    expect(formatNextScheduledTaskRun(next.toISOString(), now)).toBe(
      `Next run next ${next.toLocaleDateString([], { weekday: "long" })} at ${timeLabel(next)}`,
    );
  });

  it("includes the date for more distant runs and the year only when necessary", () => {
    for (const next of [new Date(2026, 9, 5, 9), new Date(2027, 0, 1, 9)]) {
      const date = next.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        ...(next.getFullYear() === 2026 ? {} : { year: "numeric" as const }),
      });
      expect(formatNextScheduledTaskRun(next.toISOString(), now)).toBe(
        `Next run ${date} at ${timeLabel(next)}`,
      );
    }
  });

  it("does not show an invalid date", () => {
    expect(formatNextScheduledTaskRun("invalid", now)).toBe("Next run unavailable");
  });
});
