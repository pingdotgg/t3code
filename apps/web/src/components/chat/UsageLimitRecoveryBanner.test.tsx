import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
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

  it.each([null, new Date(2026, 9, 20, 17, 30)])(
    "shows provider capacity detail with the reported reset %s",
    (resetAt) => {
      using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
      const message =
        "Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 30 s)";
      const item = usageLimitRecoveryBannerItem({
        runId: RunId.make("run-capacity"),
        resetAt: resetAt?.toISOString() ?? null,
        stoppedAt: stoppedAt.toISOString(),
        snoozedUntil: null,
        recovery: null,
        timestampFormat: "24-hour",
        failure: { class: "usage_limit", code: "provider.rate-limit", message },
        onChange: async () => {},
      });

      expect(item.title).toBe("Provider at capacity");
      expect(item.description).toBe(resetAt ? `${message} Resets 17:30.` : message);
      if (resetAt) expect(item.actions).not.toBeNull();
      else expect(item.actions).toBeNull();
    },
  );
});
