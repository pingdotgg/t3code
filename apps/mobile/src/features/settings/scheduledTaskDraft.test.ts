import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  createDraft,
  DEFAULT_SCHEDULE,
  hasScheduledTaskDraftChanges,
  scheduleFromDraft,
} from "./scheduledTaskDraft";

describe("hasScheduledTaskDraftChanges", () => {
  it("leaves an untouched form clean and clears changes when edits are reverted", () => {
    const initial = createDraft(null, null);
    const edited = { ...initial, prompt: "Review open issues" };
    expect(hasScheduledTaskDraftChanges(initial, createDraft(null, null))).toBe(false);
    expect(hasScheduledTaskDraftChanges(initial, edited)).toBe(true);
    expect(hasScheduledTaskDraftChanges(initial, { ...edited, prompt: initial.prompt })).toBe(
      false,
    );
  });

  it("keeps invalid, unsaved schedule input dirty", () => {
    const initial = createDraft(null, null);
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        schedule: { ...initial.schedule, weekdays: [] },
      }),
    ).toBe(true);
  });

  it("does not warn after deselecting and reselecting the same weekdays", () => {
    const initial = createDraft(null, null);
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        schedule: { ...initial.schedule, weekdays: [2, 3, 4, 5, 1] },
      }),
    ).toBe(false);
  });

  it("detects changes from the branch and model pickers", () => {
    const initial = createDraft(null, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
    expect(hasScheduledTaskDraftChanges(initial, { ...initial, baseRef: "release" })).toBe(true);
    expect(hasScheduledTaskDraftChanges(initial, { ...initial, startFromOrigin: false })).toBe(
      true,
    );
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        modelSelection: {
          ...initial.modelSelection!,
          options: [
            { id: "fastMode", value: false },
            { id: "effort", value: "high" },
          ],
        },
      }),
    ).toBe(false);
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        modelSelection: {
          ...initial.modelSelection!,
          options: [
            { id: "effort", value: "low" },
            { id: "fastMode", value: false },
          ],
        },
      }),
    ).toBe(true);
  });
});

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

  it("does not add a missing run day when an existing schedule contains duplicates", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [1, 2, 3, 4, 5, 6, 6] })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
      weekdays: [1, 2, 3, 4, 5, 6],
    });
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [0, 1, 2, 3, 4, 5, 6, 6] })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
    });
  });

  it.each([-1, 7, 1.5, NaN])(
    "rejects invalid weekday %s instead of scheduling every day",
    (day) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [0, 1, 2, 3, 4, 5, day] }),
      ).toBeNull();
    },
  );

  it("rejects malformed times and sub-minute intervals", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, timeOfDay: "25:00" })).toBeNull();
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes: "0" }),
    ).toBeNull();
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes: "15" }),
    ).toEqual({
      type: "interval",
      everyMs: 900_000,
    });
  });

  it.each([
    ["1.5", 90_000],
    ["1000001", 60_000_060_000],
    [String(60_001 / 60_000), 60_001],
    [String(65_000 / 60_000), 65_000],
    [String(123_456 / 60_000), 123_456],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes })).toEqual({
      type: "interval",
      everyMs,
    });
  });

  it.each(["NaN", "Infinity", "9007199254740991", "0.5"])(
    "rejects intervals that cannot be written as safe whole milliseconds: %s",
    (intervalMinutes) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes }),
      ).toBeNull();
    },
  );
});
