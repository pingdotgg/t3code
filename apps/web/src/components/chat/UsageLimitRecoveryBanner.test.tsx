import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(
  resetAt: Date,
  timestampFormat: TimestampFormat,
  recoveryProps: Partial<Parameters<typeof usageLimitRecoveryBannerItem>[0]> = {},
) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
    ...recoveryProps,
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it.each([
    [false, 14, "Resumes 18:00"],
    [true, 14, "Resumes 14:00"],
    [false, 20, "Resumes 20:00"],
    [true, 20, "Resumes 20:00"],
  ] as const)(
    "shows the continuation time with early reset %s and snooze until %s",
    (resetEarly, hour, expected) => {
      using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
      const resetAt = new Date(2026, 9, 20, 18, 0);
      expect(
        bannerDescription(resetAt, "24-hour", {
          snoozedUntil: new Date(2026, 9, 20, hour, 0).toISOString(),
          recovery: {
            runId: RunId.make("run-1"),
            resetAt: resetAt.toISOString(),
            autoResume: true,
            snooze: false,
            resetEarly,
          },
        }),
      ).toBe(expected);
    },
  );

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});
