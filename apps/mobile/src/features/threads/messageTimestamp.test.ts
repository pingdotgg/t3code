import { describe, expect, it, vi } from "vite-plus/test";

import { createMessageTimeFormatter, formatMessageTimestamp } from "./messageTimestamp";

describe("formatMessageTimestamp", () => {
  const now = new Date(2026, 10, 8, 20, 0).getTime();
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("shows only the time for today, and the day and month for any earlier day", () => {
    const today = new Date(2026, 10, 8, 0, 5);
    const yesterday = new Date(2026, 10, 7, 23, 55);
    const lastYear = new Date(2025, 10, 5, 19, 17);
    expect(formatMessageTimestamp(today.toISOString(), now)).toBe(time(today));
    expect(formatMessageTimestamp(yesterday.toISOString(), now)).toBe(
      `${yesterday.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} ${time(yesterday)}`,
    );
    expect(formatMessageTimestamp(lastYear.toISOString(), now)).toBe(
      `${lastYear.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "numeric" })} ${time(lastYear)}`,
    );
  });

  it("follows a system time zone change", () => {
    const previous = process.env.TZ;
    vi.useFakeTimers({ now: 0 });
    const sameDay = "2026-11-07T04:45:43.877Z";
    const earlierInWeek = "2026-11-04T20:00:00.000Z";
    const nowMs = Date.parse(sameDay);
    const timeIn = (iso: string, timeZone: string) =>
      new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone });
    const dayIn = (iso: string, timeZone: string) =>
      new Date(iso).toLocaleDateString(undefined, { month: "numeric", day: "numeric", timeZone });
    try {
      // Node re-resolves the default zone when TZ is assigned, like the OS zone changing.
      process.env.TZ = "America/New_York";
      const format24 = createMessageTimeFormatter(true);
      expect(formatMessageTimestamp(sameDay, nowMs)).toBe(timeIn(sameDay, "America/New_York"));
      expect(format24(sameDay, nowMs)).toBe("23:45");
      process.env.TZ = "Asia/Bangkok";
      vi.setSystemTime(Date.now() + 1_000);
      expect(formatMessageTimestamp(sameDay, nowMs)).toBe(timeIn(sameDay, "Asia/Bangkok"));
      expect(format24(sameDay, nowMs)).toBe("11:45");
      expect(formatMessageTimestamp(earlierInWeek, nowMs)).toBe(
        `${dayIn(earlierInWeek, "Asia/Bangkok")} ${timeIn(earlierInWeek, "Asia/Bangkok")}`,
      );
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("createMessageTimeFormatter", () => {
  const now = new Date(2026, 0, 1, 20, 0).getTime();

  it("follows the system clock preference over the locale's hour cycle", () => {
    const format24 = createMessageTimeFormatter(true, "en-US");
    expect(format24(new Date(2026, 0, 1, 15, 7).toISOString(), now)).toBe("15:07");
    expect(format24(new Date(2026, 0, 1, 0, 7).toISOString(), now)).toBe("00:07");
    const format12 = createMessageTimeFormatter(false, "en-GB");
    expect(format12(new Date(2026, 0, 1, 15, 7).toISOString(), now)).toMatch(/^3:07\spm$/i);
  });
});
