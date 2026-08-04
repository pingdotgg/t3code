import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageLimitMessage,
  normalizeUsageLimitResetsAt,
  parseUsageLimitStderrLine,
  usageLimitWindowLabel,
} from "./usageLimit.ts";

describe("normalizeUsageLimitResetsAt", () => {
  it("promotes epoch seconds to milliseconds and leaves milliseconds alone", () => {
    expect(normalizeUsageLimitResetsAt(1_800_000_000)).toBe(1_800_000_000_000);
    expect(normalizeUsageLimitResetsAt(1_800_000_000_000)).toBe(1_800_000_000_000);
  });

  it("rejects non-timestamps", () => {
    expect(normalizeUsageLimitResetsAt(0)).toBe(undefined);
    expect(normalizeUsageLimitResetsAt(-1)).toBe(undefined);
    expect(normalizeUsageLimitResetsAt("1800000000")).toBe(undefined);
    expect(normalizeUsageLimitResetsAt(undefined)).toBe(undefined);
    expect(normalizeUsageLimitResetsAt(Number.NaN)).toBe(undefined);
  });
});

describe("usageLimitWindowLabel", () => {
  it("labels known windows and refuses to leak unknown identifiers", () => {
    expect(usageLimitWindowLabel("five_hour")).toBe("5-hour");
    expect(usageLimitWindowLabel("seven_day")).toBe("weekly");
    expect(usageLimitWindowLabel("something_new")).toBe(null);
    expect(usageLimitWindowLabel(undefined)).toBe(null);
  });
});

describe("buildUsageLimitMessage", () => {
  it("builds copy from structured fields only", () => {
    expect(buildUsageLimitMessage({ windowType: "five_hour", resetsAt: 1_800_000_000 })).toBe(
      "5-hour usage limit reached. Resets at 2027-01-15T08:00:00.000Z.",
    );
    expect(buildUsageLimitMessage({ windowType: "seven_day" })).toBe("weekly usage limit reached.");
    expect(buildUsageLimitMessage({})).toBe("Usage limit reached.");
  });
});

describe("parseUsageLimitStderrLine", () => {
  it("extracts only the reset epoch from the CLI line", () => {
    expect(parseUsageLimitStderrLine("Claude AI usage limit reached|1800000000")).toEqual({
      resetsAt: 1_800_000_000_000,
    });
  });

  it("still flags the limit when no epoch is present", () => {
    expect(parseUsageLimitStderrLine("claude ai usage limit reached")).toEqual({});
  });

  it("ignores unrelated stderr", () => {
    expect(parseUsageLimitStderrLine("some token=secret debug line")).toBe(undefined);
  });
});
