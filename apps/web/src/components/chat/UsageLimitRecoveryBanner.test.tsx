import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerItem(
  resetAt: Date | null,
  timestampFormat: TimestampFormat,
  errorCode: string | null = null,
) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode,
    resetAt: resetAt?.toISOString() ?? null,
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    checkLimits: { pending: false, run: () => {} },
    onChange: async () => {},
  });
}

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return bannerItem(resetAt, timestampFormat).description;
}

describe("usageLimitRecoveryBannerItem", () => {
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

  it("offers a limits check only when the reset time is unknown", () => {
    const actions = (resetAt: Date | null) =>
      renderToStaticMarkup(<>{bannerItem(resetAt, "24-hour").actions}</>);
    expect(actions(null)).toContain("Check limits");
    expect(actions(new Date(2026, 9, 20, 17, 30))).not.toContain("Check limits");
  });
});
