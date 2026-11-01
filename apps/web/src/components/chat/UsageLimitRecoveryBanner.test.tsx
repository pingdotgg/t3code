import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function banner(resetAt: Date, timestampFormat: TimestampFormat, settled = false) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  });
}

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return banner(resetAt, timestampFormat).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("points a settled thread at Un-settle instead of offering recovery the server refuses", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    const resetAt = new Date(2026, 9, 20, 17, 30);
    expect(banner(resetAt, "24-hour").actions).not.toBeNull();
    const settled = banner(resetAt, "24-hour", true);
    expect(settled.actions).toBeNull();
    expect(settled.description).toBe("Resets 17:30. Un-settle to resume at reset");
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});
