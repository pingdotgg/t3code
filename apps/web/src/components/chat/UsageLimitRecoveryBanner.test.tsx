import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    failureCode: "usageLimitExceeded",
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["responseTooManyFailedAttempts", "Provider rate limit (HTTP 429)"],
    ["usageLimitExceeded", "Usage limit reached"],
  ] as const)("keeps %s manually recoverable without a reported reset", (failureCode, title) => {
    const banner = usageLimitRecoveryBannerItem({
      runId: RunId.make("run-1"),
      failureCode,
      resetAt: null,
      stoppedAt: stoppedAt.toISOString(),
      snoozedUntil: null,
      recovery: null,
      timestampFormat: "24-hour",
      onChange: async () => {},
    });
    expect(banner.title).toBe(title);
    expect(banner.description).toBe("No reset time reported; retry manually");
    expect(banner.actions).toBeNull();
  });

  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});
