import { describe, expect, it } from "vite-plus/test";

import {
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
  it("follows a system time zone change without a reload", () => {
    const instant = "2026-11-07T04:45:43.877Z";
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatShortTimestamp(instant, "12-hour")).toBe("11:45 PM");
      expect(formatDayAwareTimestamp(instant, "12-hour", now)).toBe("11/6 11:45 PM");

      process.env.TZ = "Asia/Bangkok";
      expect(formatShortTimestamp(instant, "12-hour")).toBe("11:45 AM");
      expect(formatDayAwareTimestamp(instant, "12-hour", now)).toBe("11/7 11:45 AM");
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });
});
