import { describe, expect, it } from "vite-plus/test";

import {
  mergeAndroidPickerValue,
  resolveAndroidMinimumDate,
  resolveAndroidPickerValue,
  resolveAndroidSnoozeValue,
} from "./SnoozeForRouteScreen.logic";

const wallTime = {
  year: 2026,
  month: 8,
  day: 10,
  hour: 13,
  minute: 45,
} as const;

describe("resolveAndroidPickerValue", () => {
  it("seeds Material DatePicker with UTC midnight for the local calendar day", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";

      expect(resolveAndroidPickerValue(wallTime, "date").toISOString()).toBe(
        "2026-08-10T00:00:00.000Z",
      );
      const timeValue = resolveAndroidPickerValue(wallTime, "time");
      expect(timeValue.getHours()).toBe(13);
      expect(timeValue.getMinutes()).toBe(45);
    } finally {
      process.env.TZ = originalTimezone;
    }
  });
});

describe("resolveAndroidMinimumDate", () => {
  it("allows the current local calendar day in western timezones", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const localEvening = new Date(2026, 7, 10, 20, 30);

      expect(localEvening.toISOString()).toContain("2026-08-11");
      expect(resolveAndroidMinimumDate(localEvening).toISOString()).toBe(
        "2026-08-10T00:00:00.000Z",
      );
    } finally {
      process.env.TZ = originalTimezone;
    }
  });
});

describe("mergeAndroidPickerValue", () => {
  it("reads Material DatePicker calendar parts from UTC", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const selected = new Date(Date.UTC(2026, 7, 12));

      const merged = mergeAndroidPickerValue(wallTime, selected, "date");

      expect(selected.getDate()).toBe(11);
      expect(merged).toEqual({ ...wallTime, day: 12 });
    } finally {
      process.env.TZ = originalTimezone;
    }
  });

  it("keeps the current local day when merging a selected time", () => {
    const selected = new Date(2026, 7, 10, 18, 30);

    const merged = mergeAndroidPickerValue(wallTime, selected, "time");

    expect(merged).toEqual({ ...wallTime, hour: 18, minute: 30 });
  });

  it("preserves a nonexistent Android wall time so validation can reject it", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const current = { ...wallTime, month: 3, day: 8, hour: 1, minute: 30 };
      const selected = new Date(2000, 0, 15, 2, 30);

      const merged = mergeAndroidPickerValue(current, selected, "time");
      const result = resolveAndroidSnoozeValue(merged, {
        now: new Date(2026, 2, 7, 12),
      });

      expect(merged).toEqual({ ...current, hour: 2, minute: 30 });
      expect(result).toEqual({ ok: false, error: "Choose a valid date and time." });
    } finally {
      process.env.TZ = originalTimezone;
    }
  });

  it("uses the still-future occurrence of a repeated Android wall time", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const current = { ...wallTime, month: 11, day: 1, hour: 0, minute: 30 };
      const selected = new Date(2000, 0, 15, 1, 30);
      const firstOccurrence = new Date(2026, 10, 1, 1, 30);
      const secondOccurrence = new Date(firstOccurrence.getTime() + 60 * 60 * 1_000);

      const merged = mergeAndroidPickerValue(current, selected, "time");
      const result = resolveAndroidSnoozeValue(merged, {
        now: new Date(firstOccurrence.getTime() + 30 * 60 * 1_000),
      });

      expect(secondOccurrence.getHours()).toBe(1);
      expect(result).toEqual({ ok: true, value: secondOccurrence });
    } finally {
      process.env.TZ = originalTimezone;
    }
  });
});
