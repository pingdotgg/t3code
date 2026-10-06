import { describe, expect, it } from "vite-plus/test";

import {
  binEndMs,
  binStartMs,
  formatBin,
  previousWindow,
  startOfDayMs,
  timelineFor,
  windowFor,
} from "./usageWindow";

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe("usage windows", () => {
  const now = new Date("2026-10-04T15:42:30Z");

  it("reads the week hourly from local midnight six days back", () => {
    const window = windowFor({ kind: "period", days: 7 }, now);
    expect(window.resolution).toBe("hour");
    expect(window.groupByThread).toBe(true);
    expect(Date.parse(window.untilTime!)).toBe(Date.parse("2026-10-04T15:42:00Z"));
    const firstDay = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(
      new Date(window.sinceTime!),
    );
    expect(window.sinceDay).toBe(firstDay);
    // Six-hour intervals for a week.
    expect(timelineFor(window).binMinutes).toBe(360);
  });

  it("reads long custom ranges by day and short ones by hour", () => {
    expect(
      windowFor({ kind: "days", sinceDay: "2026-09-01", untilDay: "2026-09-30" }, now).resolution,
    ).toBe("day");
    const short = windowFor({ kind: "days", sinceDay: "2026-10-02", untilDay: "2026-10-03" }, now);
    expect(short.resolution).toBe("hour");
    expect(Date.parse(short.sinceTime!)).toBe(startOfDayMs("2026-10-02", zone));
    expect(timelineFor(short).binMinutes).toBe(60);
  });

  it("compares against the same length of time just before", () => {
    const daily = windowFor({ kind: "period", days: 30 }, now);
    const before = previousWindow(daily);
    expect(timelineFor(before).days).toHaveLength(30);
    expect(before.untilDay < daily.sinceDay).toBe(true);
  });

  it("finds local midnight across a daylight-saving change", () => {
    // Sydney moves to daylight time on 2026-10-04; midnight is still UTC+10.
    expect(new Date(startOfDayMs("2026-10-04", "Australia/Sydney")).toISOString()).toBe(
      "2026-10-03T14:00:00.000Z",
    );
    expect(new Date(startOfDayMs("2026-10-05", "Australia/Sydney")).toISOString()).toBe(
      "2026-10-04T13:00:00.000Z",
    );
  });

  it("puts six-hour interval edges on the local clock across a DST change", () => {
    // Sydney skips 2am to 3am on 2026-10-04, so its first interval is five hours.
    const zone = "Australia/Sydney";
    expect(new Date(binStartMs("2026-10-04T06", zone)).toISOString()).toBe(
      "2026-10-03T19:00:00.000Z",
    );
    expect(binEndMs("2026-10-04T00", 360, zone)).toBe(binStartMs("2026-10-04T06", zone));
    expect(binEndMs("2026-10-04T00", 360, zone) - binStartMs("2026-10-04T00", zone)).toBe(
      5 * 60 * 60 * 1000,
    );
    expect(binEndMs("2026-10-04T18", 360, zone)).toBe(startOfDayMs("2026-10-05", zone));
  });

  it("labels six-hour intervals with their span", () => {
    expect(formatBin("2026-10-01T18", zone)).toBe("Oct 1, 6pm–12am");
    expect(formatBin("2026-10-01", zone)).toBe("Oct 1");
  });
});
