import { describe, expect, it } from "vite-plus/test";
import { byTimestamp, compareTimestamps, msUntilRelativeTimeChange, relativeTime } from "./time";

const at = "2026-10-19T12:00:00.000Z";
const timestamp = Date.parse(at);

describe("timestamp order", () => {
  it("orders host timestamps by instant across offsets and fractional seconds, missing ones first", () => {
    const dates = [
      "2026-07-05T00:30:00.5Z",
      "2026-07-05T01:00:00+02:00",
      "",
      "2026-07-05T00:30:00Z",
    ];

    expect(dates.toSorted(compareTimestamps)).toEqual([
      "",
      "2026-07-05T01:00:00+02:00",
      "2026-07-05T00:30:00Z",
      "2026-07-05T00:30:00.5Z",
    ]);
  });
  it("keeps equal instants in input order whichever way it sorts", () => {
    const rows = [
      { id: "comment", date: "2026-07-05T00:30:00Z" },
      { id: "commit", date: "2026-07-04T20:30:00-04:00" },
      { id: "older", date: "2026-07-04T00:00:00Z" },
    ];
    const ids = (newestFirst: boolean) =>
      rows.toSorted(byTimestamp(newestFirst)).map((row) => row.id);

    expect(ids(false)).toEqual(["older", "comment", "commit"]);
    expect(ids(true)).toEqual(["comment", "commit", "older"]);
  });
});

describe("relative time", () => {
  it.each([
    [59_999, "<1m", "1m"],
    [119_999, "1m", "2m"],
    [3_599_999, "59m", "1h"],
    [7_199_999, "1h", "2h"],
    [86_399_999, "23h", "1d"],
    [172_799_999, "1d", "2d"],
  ] as const)("updates at the next boundary after %i ms", (elapsed, before, after) => {
    const nowMs = timestamp + elapsed;
    expect(relativeTime(at, nowMs)).toBe(before);
    expect(msUntilRelativeTimeChange(at, nowMs)).toBe(1);
    expect(relativeTime(at, nowMs + 1)).toBe(after);
  });

  it.each([
    [0, 60_000],
    [60_000, 60_000],
    [3_600_000, 3_600_000],
    [86_400_000, 86_400_000],
  ])("waits a full label interval at %i ms", (elapsed, delay) => {
    expect(msUntilRelativeTimeChange(at, timestamp + elapsed)).toBe(delay);
  });

  it("keeps invalid timestamps static", () => {
    expect(relativeTime("invalid", timestamp)).toBe("<1m");
    expect(msUntilRelativeTimeChange("invalid", timestamp)).toBeNull();
  });

  it("waits until a future timestamp is a minute old, with bounded timers", () => {
    expect(relativeTime(at, timestamp - 30_000)).toBe("<1m");
    expect(msUntilRelativeTimeChange(at, timestamp - 30_000)).toBe(90_000);
    expect(msUntilRelativeTimeChange(at, timestamp - 30 * 86_400_000)).toBe(86_400_000);
  });
});
