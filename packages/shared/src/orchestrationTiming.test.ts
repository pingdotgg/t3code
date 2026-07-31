import { describe, expect, it } from "vite-plus/test";

import {
  formatCompactWorkingDuration,
  formatDuration,
  formatElapsed,
  formatWorkingDuration,
} from "./orchestrationTiming.js";

describe("formatWorkingDuration", () => {
  it("shows whole seconds for the first minute", () => {
    expect(formatWorkingDuration(Number.NaN)).toBe("1s");
    expect(formatWorkingDuration(-1)).toBe("1s");
    expect(formatWorkingDuration(0)).toBe("1s");
    expect(formatWorkingDuration(999)).toBe("1s");
    expect(formatWorkingDuration(1_000)).toBe("1s");
    expect(formatWorkingDuration(1_999)).toBe("1s");
    expect(formatWorkingDuration(2_000)).toBe("2s");
    expect(formatWorkingDuration(9_999)).toBe("9s");
    expect(formatWorkingDuration(10_000)).toBe("10s");
    expect(formatWorkingDuration(10_999)).toBe("10s");
    expect(formatWorkingDuration(11_000)).toBe("11s");
    expect(formatWorkingDuration(59_999)).toBe("59s");
  });

  it("shows minutes with remaining seconds for the first hour", () => {
    expect(formatWorkingDuration(60_000)).toBe("1m");
    expect(formatWorkingDuration(119_999)).toBe("1m 59s");
    expect(formatWorkingDuration(11 * 60_000 + 30_000)).toBe("11m 30s");
    expect(formatWorkingDuration(5 * 60_000)).toBe("5m");
    expect(formatWorkingDuration(59 * 60_000)).toBe("59m");
  });

  it("shows hours with remaining minutes", () => {
    expect(formatWorkingDuration(60 * 60_000)).toBe("1h");
    expect(formatWorkingDuration(61 * 60_000)).toBe("1h 1m");
    expect(formatWorkingDuration(23 * 60 * 60_000 + 59 * 60_000)).toBe("23h 59m");
  });

  it("shows days with remaining hours", () => {
    expect(formatWorkingDuration(24 * 60 * 60_000)).toBe("1d");
    expect(formatWorkingDuration(25 * 60 * 60_000)).toBe("1d 1h");
    expect(formatWorkingDuration(3 * 24 * 60 * 60_000 + 4 * 60 * 60_000)).toBe("3d 4h");
  });
});

describe("formatCompactWorkingDuration", () => {
  it("keeps seconds alone and truncates sub-hour durations to whole minutes", () => {
    expect(formatCompactWorkingDuration(999)).toBe("1s");
    expect(formatCompactWorkingDuration(59_999)).toBe("59s");
    expect(formatCompactWorkingDuration(60_000)).toBe("1m");
    expect(formatCompactWorkingDuration(11 * 60_000 + 30_000)).toBe("11m");
    expect(formatCompactWorkingDuration(59 * 60_000 + 59_000)).toBe("59m");
  });

  it("matches the chat formatter at hour and day precision", () => {
    expect(formatCompactWorkingDuration(61 * 60_000)).toBe("1h 1m");
    expect(formatCompactWorkingDuration(25 * 60 * 60_000)).toBe("1d 1h");
  });
});

describe("formatDuration", () => {
  it("preserves the existing sub-minute precision", () => {
    expect(formatDuration(0)).toBe("1ms");
    expect(formatDuration(750)).toBe("750ms");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(9_950)).toBe("9.9s");
    expect(formatDuration(9_999)).toBe("10.0s");
    expect(formatDuration(42_000)).toBe("42s");
  });

  it("keeps sub-hour durations in minutes and seconds", () => {
    expect(formatDuration(135_000)).toBe("2m 15s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("rolls long durations up into hours", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(8_138_000)).toBe("2h 15m");
    expect(formatDuration(86_399_000)).toBe("23h 59m");
  });

  it("rolls multi-day durations up into days", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(93_600_000)).toBe("1d 2h");
    expect(formatDuration(273_600_000)).toBe("3d 4h");
  });

  it("formats an elapsed multi-day turn through the shared mobile path", () => {
    expect(formatElapsed("2026-07-28T23:45:00.000Z", "2026-07-30T01:45:00.000Z")).toBe("1d 2h");
  });
});
