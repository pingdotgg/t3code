// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  compareUsageDays,
  enumerateHourStarts,
  formatCoverageTime,
  formatDateTimeShort,
  formatHourShort,
  formatRelativeHourShort,
  makeCustomWindow,
  makeWindow,
} from "./usageFormat.ts";

describe("compareUsageDays", () => {
  it("compares strict four-digit calendar dates numerically", () => {
    expect(compareUsageDays("2026-08-03", "2026-08-11")).toBe(-1);
    expect(compareUsageDays("2026-08-11", "2026-08-03")).toBe(1);
    expect(compareUsageDays("2026-08-03", "2026-08-03")).toBe(0);
  });

  it("rejects variable-width years and impossible dates", () => {
    expect(compareUsageDays("10000-01-01", "9999-12-31")).toBeNull();
    expect(compareUsageDays("2026-02-29", "2026-03-01")).toBeNull();
  });
});

describe("hourly usage formatting", () => {
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
    expect(formatCoverageTime("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5:37 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
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
    expect(window.sinceTime).toBe("2026-08-10T12:30:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:30:00.000Z");
  });

  it("ends daily requests at the last complete calendar day", () => {
    const window = makeWindow(30, new Date("2026-08-11T12:37:42.123Z"));

    expect(window.sinceDay).toBe("2026-07-12");
    expect(window.untilDay).toBe("2026-08-10");
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

describe("makeCustomWindow", () => {
  it("builds a daily window over the inclusive range", () => {
    const window = makeCustomWindow("2026-08-03", "2026-08-11");

    expect(window.sinceDay).toBe("2026-08-03");
    expect(window.untilDay).toBe("2026-08-11");
    expect(window.resolution).toBe("day");
    expect(window.sinceTime).toBeUndefined();
  });

  it("swaps out-of-order bounds so a raw drag never produces an invalid window", () => {
    const window = makeCustomWindow("2026-08-11", "2026-08-03");

    expect(window.sinceDay).toBe("2026-08-03");
    expect(window.untilDay).toBe("2026-08-11");
  });

  it("caps typed ranges at the largest supported 90-day window", () => {
    const window = makeCustomWindow("0001-01-01", "9999-12-31");

    expect(window.sinceDay).toBe("0001-01-01");
    expect(window.untilDay).toBe("0001-03-31");
  });

  it("rejects bounds outside the strict day format", () => {
    expect(() => makeCustomWindow("10000-01-01", "9999-12-31")).toThrow(RangeError);
  });
});
