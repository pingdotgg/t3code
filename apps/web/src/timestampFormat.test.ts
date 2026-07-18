import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatRelativeTimeUntil,
  formatRelativeTimeUntilLabel,
  formatShortTimestamp,
  formatTimestamp,
  getRelativeTimeState,
  getTimestampFormatOptions,
} from "./timestampFormat";

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("formatRelativeTimeUntilLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });

  it("formats seconds remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:00:45.000Z")).toBe("45s left");
  });

  it("formats minutes remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:15:00.000Z")).toBe("15m left");
  });

  it("formats hours remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T18:00:00.000Z")).toBe("6h left");
  });
});

describe("formatExpiresInLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatExpiresInLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });

  it("uses sub-minute second count", () => {
    expect(formatExpiresInLabel("2026-04-07T12:00:45.000Z")).toBe("Expires in 45s");
  });

  it("uses minutes and seconds under one hour", () => {
    expect(formatExpiresInLabel("2026-04-07T12:04:12.000Z")).toBe("Expires in 4m 12s");
    expect(formatExpiresInLabel("2026-04-07T12:15:00.000Z")).toBe("Expires in 15m");
  });

  it("uses hours with minute and second remainder", () => {
    expect(formatExpiresInLabel("2026-04-07T14:02:03.000Z")).toBe("Expires in 2h 2m 3s");
    expect(formatExpiresInLabel("2026-04-07T18:00:00.000Z")).toBe("Expires in 6h");
  });
});

describe("invalid timestamp inputs", () => {
  it("returns an empty timestamp instead of throwing", () => {
    expect(() => formatTimestamp("not-a-date", "12-hour")).not.toThrow();
    expect(formatTimestamp("not-a-date", "12-hour")).toBe("");
  });

  it("returns an empty short timestamp instead of throwing", () => {
    expect(() => formatShortTimestamp("not-a-date", "12-hour")).not.toThrow();
    expect(formatShortTimestamp("not-a-date", "12-hour")).toBe("");
  });

  it("returns an empty relative time label instead of a NaN label", () => {
    expect(formatRelativeTime("not-a-date")).toBeNull();
    expect(formatRelativeTimeLabel("not-a-date")).toBe("");
  });

  it("distinguishes missing and invalid relative time state", () => {
    expect(getRelativeTimeState(null)).toEqual({ status: "missing" });
    expect(getRelativeTimeState("not-a-date")).toEqual({ status: "invalid" });
  });

  it("returns an empty elapsed duration instead of a NaN label", () => {
    expect(formatElapsedDurationLabel("not-a-date")).toBe("");
  });

  it("returns an empty relative time until label instead of a NaN label", () => {
    expect(formatRelativeTimeUntil("not-a-date")).toBeNull();
    expect(formatRelativeTimeUntilLabel("not-a-date")).toBe("");
  });

  it("returns an empty expires-in label instead of a NaN label", () => {
    expect(formatExpiresInLabel("not-a-date")).toBe("");
  });
});

describe("getRelativeTimeState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns relative parts for valid timestamps", () => {
    expect(getRelativeTimeState("2026-04-07T11:45:00.000Z")).toEqual({
      status: "relative",
      value: "15m",
      suffix: "ago",
    });
  });
});

describe("formatElapsedDurationLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns just now when the instant is current or in the future", () => {
    expect(formatElapsedDurationLabel("2026-04-07T12:00:00.000Z")).toBe("just now");
    expect(formatElapsedDurationLabel("2026-04-07T12:01:00.000Z")).toBe("just now");
  });

  it("formats seconds, minutes, hours, and days", () => {
    expect(formatElapsedDurationLabel("2026-04-07T11:59:45.000Z")).toBe("15s");
    expect(formatElapsedDurationLabel("2026-04-07T11:45:00.000Z")).toBe("15m");
    expect(formatElapsedDurationLabel("2026-04-07T06:00:00.000Z")).toBe("6h");
    expect(formatElapsedDurationLabel("2026-04-03T12:00:00.000Z")).toBe("4d");
  });
});
