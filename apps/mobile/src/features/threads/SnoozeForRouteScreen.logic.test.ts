import { describe, expect, it } from "vite-plus/test";

import { mergeAndroidPickerValue, resolveAndroidPickerValue } from "./SnoozeForRouteScreen.logic";

describe("resolveAndroidPickerValue", () => {
  it("seeds Material DatePicker with UTC midnight for the local calendar day", () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const localEvening = new Date(2026, 7, 10, 20, 30);

      expect(localEvening.toISOString()).toContain("2026-08-11");
      expect(resolveAndroidPickerValue(localEvening, "date").toISOString()).toBe(
        "2026-08-10T00:00:00.000Z",
      );
      expect(resolveAndroidPickerValue(localEvening, "time")).toBe(localEvening);
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
      const current = new Date(2026, 7, 10, 13, 45);
      const selected = new Date(Date.UTC(2026, 7, 12));

      const merged = mergeAndroidPickerValue(current, selected, "date");

      expect(selected.getDate()).toBe(11);
      expect(merged.getFullYear()).toBe(2026);
      expect(merged.getMonth()).toBe(7);
      expect(merged.getDate()).toBe(12);
      expect(merged.getHours()).toBe(13);
      expect(merged.getMinutes()).toBe(45);
    } finally {
      process.env.TZ = originalTimezone;
    }
  });

  it("keeps the current local day when merging a selected time", () => {
    const current = new Date(2026, 7, 10, 13, 45);
    const selected = new Date(2026, 7, 10, 18, 30);

    const merged = mergeAndroidPickerValue(current, selected, "time");

    expect(merged).toEqual(new Date(2026, 7, 10, 18, 30));
  });
});
