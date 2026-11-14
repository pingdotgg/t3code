import { describe, expect, it } from "vite-plus/test";

import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatUpcomingTimestamp,
} from "./timestampFormat";

// Node re-resolves the default zone when TZ is assigned, like a renderer after the OS zone changes.
function useTimeZone(timeZone: string): Disposable {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  return {
    [Symbol.dispose]: () => {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    },
  };
}

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

describe("timestamps after the system time zone changes", () => {
  // Built fresh with an explicit zone, so expectations follow the host locale but not a stale zone.
  const timeIn = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(new Date(iso));
  const dayIn = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", timeZone }).format(
      new Date(iso),
    );

  it("renders the gutter label in the new zone", () => {
    const sameDay = "2026-11-07T04:45:43.877Z";
    const earlierInWeek = "2026-11-04T20:00:00.000Z";
    const now = Date.parse(sameDay);
    using _zone = useTimeZone("America/New_York");
    expect([
      formatDayAwareTimestamp(sameDay, "12-hour", now),
      formatDayAwareTimestamp(earlierInWeek, "12-hour", now),
    ]).toEqual([
      timeIn(sameDay, "America/New_York"),
      `${dayIn(earlierInWeek, "America/New_York")} ${timeIn(earlierInWeek, "America/New_York")}`,
    ]);

    process.env.TZ = "Asia/Bangkok";
    expect([
      formatDayAwareTimestamp(sameDay, "12-hour", now),
      formatDayAwareTimestamp(earlierInWeek, "12-hour", now),
    ]).toEqual([
      timeIn(sameDay, "Asia/Bangkok"),
      `${dayIn(earlierInWeek, "Asia/Bangkok")} ${timeIn(earlierInWeek, "Asia/Bangkok")}`,
    ]);
  });

  it("renders the tooltip in the new zone", () => {
    const monthEnd = "2026-10-31T20:00:00.000Z";
    using _zone = useTimeZone("America/New_York");
    expect(formatChatTimestampTooltip(monthEnd, "12-hour")).toBe(
      `${timeIn(monthEnd, "America/New_York")}, 31st October 2026`,
    );

    process.env.TZ = "Asia/Bangkok";
    expect(formatChatTimestampTooltip(monthEnd, "12-hour")).toBe(
      `${timeIn(monthEnd, "Asia/Bangkok")}, 1st November 2026`,
    );
  });
});
