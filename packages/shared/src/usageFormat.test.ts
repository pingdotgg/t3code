// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatPercent,
  formatRelativeHourShort,
  makeWindow,
} from "./usageFormat.ts";

describe("formatPercent", () => {
  it("distinguishes a small positive share from zero", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0.0009)).toBe("<0.1%");
    expect(formatPercent(0.001)).toBe("0.1%");
    expect(formatPercent(0.023)).toBe("2.3%");
    expect(formatPercent(0.00004, 2)).toBe("<0.01%");
  });
});

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("uses the current system zone when no zone is supplied", () => {
    try {
      vi.stubEnv("TZ", "UTC");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("12 PM");
      vi.stubEnv("TZ", "America/New_York");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("8 AM");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("follows an explicit hour cycle and keeps the 12-hour default without one", () => {
    const afternoon = "2026-08-11T14:37:00.000Z";
    const midnight = "2026-08-11T00:37:00.000Z";

    expect(formatHourShort(afternoon, "UTC")).toBe("2 PM");
    expect(formatHourShort(afternoon, "UTC", true)).toBe("2 PM");
    expect(formatHourShort(afternoon, "UTC", false)).toBe("14:00");
    expect(formatHourShort(midnight, "UTC", true)).toBe("12 AM");
    expect(formatHourShort(midnight, "UTC", false)).toBe("00:00");

    expect(formatDateTimeShort(afternoon, "UTC")).toBe("Aug 11, 2 PM");
    expect(formatDateTimeShort(afternoon, "UTC", true)).toBe("Aug 11, 2 PM");
    expect(formatDateTimeShort(afternoon, "UTC", false)).toBe("Aug 11, 14:00");

    const windowEnd = "2026-08-11T15:37:00.000Z";
    expect(formatRelativeHourShort(afternoon, windowEnd, "UTC")).toBe("2 PM today");
    expect(formatRelativeHourShort(afternoon, windowEnd, "UTC", true)).toBe("2 PM today");
    expect(formatRelativeHourShort(afternoon, windowEnd, "UTC", false)).toBe("14:00 today");
    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC", false)).toBe(
      "17:00 yesterday",
    );
    expect(formatRelativeHourShort("2026-08-08T17:37:00.000Z", windowEnd, "UTC", false)).toBe(
      "Aug 8, 17:00",
    );
  });

  it("disambiguates repeated hours in the requested hour cycle", () => {
    const daylight = "2026-11-01T05:37:00.000Z";
    const standard = "2026-11-01T06:37:00.000Z";

    expect(formatHourShort(daylight, "America/New_York", true)).toBe("1 AM EDT");
    expect(formatHourShort(standard, "America/New_York", true)).toBe("1 AM EST");
    expect(formatHourShort(daylight, "America/New_York", false)).toBe("01:00 EDT");
    expect(formatHourShort(standard, "America/New_York", false)).toBe("01:00 EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
