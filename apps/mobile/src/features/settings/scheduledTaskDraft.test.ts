import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SCHEDULE, scheduleFromDraft } from "./scheduledTaskDraft";

describe("scheduleFromDraft", () => {
  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it("accepts a selected local time and sorts weekdays", () => {
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, timeOfDay: "18:30", weekdays: [5, 1] }),
    ).toEqual({
      type: "fixed_time",
      timeOfDay: "18:30",
      weekdays: [1, 5],
    });
  });

  it("stores every day without a weekday restriction", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [1, 2, 3, 4, 5, 6, 0] })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
    });
  });

  it("rejects malformed times and sub-minute or fractional intervals", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, timeOfDay: "25:00" })).toBeNull();
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes: "0" }),
    ).toBeNull();
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes: "1.5" }),
    ).toBeNull();
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes: "15" }),
    ).toEqual({
      type: "interval",
      everyMs: 900_000,
    });
  });
});
