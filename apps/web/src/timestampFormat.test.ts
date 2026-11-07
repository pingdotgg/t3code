import { describe, expect, it } from "vite-plus/test";

import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatShortTimestamp,
  formatUpcomingTimestamp,
} from "./timestampFormat";

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});

describe("timestamps in the system time zone", () => {
  // Expectations come from a fresh formatter pinned to each zone, so the tests pass under any host
  // locale ("11:45 PM" vs "11:45 pm", "11/6" vs "06/11") while still proving the cached formatter
  // tracks the live zone.
  const expectedTime = (instant: string, timeZone: string) =>
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(new Date(instant));
  const expectedNumericDate = (instant: string, timeZone: string) =>
    new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", timeZone }).format(
      new Date(instant),
    );

  it("follows a system time zone change without a reload", () => {
    const instant = "2026-11-07T04:45:43.877Z";
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const originalTimeZone = process.env.TZ;
    try {
      for (const zone of ["America/New_York", "Asia/Bangkok"]) {
        process.env.TZ = zone;
        const time = expectedTime(instant, zone);
        expect(formatShortTimestamp(instant, "12-hour")).toBe(time);
        expect(formatDayAwareTimestamp(instant, "12-hour", now)).toBe(
          `${expectedNumericDate(instant, zone)} ${time}`,
        );
      }
      // Guard the oracle: the zones must disagree on both the time and the date.
      expect(expectedTime(instant, "America/New_York")).not.toBe(
        expectedTime(instant, "Asia/Bangkok"),
      );
      expect(expectedNumericDate(instant, "America/New_York")).not.toBe(
        expectedNumericDate(instant, "Asia/Bangkok"),
      );
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it("names the month in the current system time zone", () => {
    // Oct 31 in New York, Nov 1 in Bangkok.
    const instant = "2026-10-31T23:45:00.000Z";
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatChatTimestampTooltip(instant, "12-hour")).toBe(
        `${expectedTime(instant, "America/New_York")}, 31st October 2026`,
      );

      process.env.TZ = "Asia/Bangkok";
      expect(formatChatTimestampTooltip(instant, "12-hour")).toBe(
        `${expectedTime(instant, "Asia/Bangkok")}, 1st November 2026`,
      );
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });
});
