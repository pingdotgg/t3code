import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { relativeTime } from "./time";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '<1m' for unparseable input", () => {
    expect(relativeTime("not-a-date")).toBe("<1m");
  });

  it("returns '<1m' for a timestamp that is right now", () => {
    expect(relativeTime(new Date(NOW).toISOString())).toBe("<1m");
  });

  it("returns '<1m' for anything under a minute old, instead of a live seconds count", () => {
    expect(relativeTime(new Date(NOW - 1_000).toISOString())).toBe("<1m");
    expect(relativeTime(new Date(NOW - 59_000).toISOString())).toBe("<1m");
  });

  it("clamps timestamps in the future to '<1m' rather than a negative duration", () => {
    expect(relativeTime(new Date(NOW + 60_000).toISOString())).toBe("<1m");
  });

  it("renders whole minutes once a minute has elapsed", () => {
    expect(relativeTime(new Date(NOW - 60_000).toISOString())).toBe("1m");
    expect(relativeTime(new Date(NOW - 90_000).toISOString())).toBe("1m");
    expect(relativeTime(new Date(NOW - 59 * 60_000).toISOString())).toBe("59m");
  });

  it("switches to hours once 60 minutes have elapsed", () => {
    expect(relativeTime(new Date(NOW - 60 * 60_000).toISOString())).toBe("1h");
    expect(relativeTime(new Date(NOW - 23 * 60 * 60_000).toISOString())).toBe("23h");
  });

  it("switches to days once 24 hours have elapsed", () => {
    expect(relativeTime(new Date(NOW - 24 * 60 * 60_000).toISOString())).toBe("1d");
    expect(relativeTime(new Date(NOW - 9 * 24 * 60 * 60_000).toISOString())).toBe("9d");
  });
});