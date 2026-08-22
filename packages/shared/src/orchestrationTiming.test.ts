import { describe, expect, it } from "vite-plus/test";

import { formatDuration } from "./orchestrationTiming.ts";

describe("formatDuration", () => {
  it("formats sub-second and second durations", () => {
    expect(formatDuration(0)).toBe("1ms");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(12_000)).toBe("12s");
  });

  it("rolls a sub-minute duration up to 1m instead of 60s", () => {
    // Math.round(59_500 / 1_000) === 60, which must render as "1m", not "60s",
    // matching the >= 60_000 branch (formatDuration(60_000) === "1m").
    expect(formatDuration(59_499)).toBe("59s");
    expect(formatDuration(59_500)).toBe("1m");
    expect(formatDuration(60_000)).toBe("1m");
  });

  it("formats minute durations", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("guards against invalid input", () => {
    expect(formatDuration(-1)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
  });
});
