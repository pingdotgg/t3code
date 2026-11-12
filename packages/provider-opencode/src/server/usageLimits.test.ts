import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { openCodeGoLimitResetAt } from "./usageLimits.ts";

const ROLLING_RESET = "2026-11-06T04:12:00.000Z";
const WEEKLY_RESET = "2026-11-09T00:00:00.000Z";
const MONTHLY_RESET = "2026-12-01T00:00:00.000Z";

const usage = (percents: {
  readonly rolling: number;
  readonly weekly: number;
  readonly monthly: number;
}): ServerProviderUsageLimits => {
  const window = (
    id: string,
    kind: ServerProviderUsageWindow["kind"],
    usedPercent: number,
    resetsAt: string,
  ): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent, resetsAt });
  return {
    checkedAt: "2026-11-06T01:49:10.000Z",
    windows: [
      window("go_rolling", "session", percents.rolling, ROLLING_RESET),
      window("go_weekly", "weekly", percents.weekly, WEEKLY_RESET),
      window("go_monthly", "monthly", percents.monthly, MONTHLY_RESET),
    ],
  };
};

describe("openCodeGoLimitResetAt", () => {
  it.each([
    ["OpenCode Go 5 hour usage limit reached.", ROLLING_RESET],
    ["OpenCode Go weekly usage limit reached.", WEEKLY_RESET],
    ["OpenCode Go monthly usage limit reached.", MONTHLY_RESET],
  ])("resumes %s when that window resets", (message, expected) => {
    expect(openCodeGoLimitResetAt(message, usage({ rolling: 90, weekly: 60, monthly: 30 }))).toBe(
      expected,
    );
  });

  it("waits for every spent window, not only the one the error names", () => {
    expect(
      openCodeGoLimitResetAt(
        "OpenCode Go 5 hour usage limit reached.",
        usage({ rolling: 100, weekly: 100, monthly: 30 }),
      ),
    ).toBe(WEEKLY_RESET);
  });

  it.each([
    "OpenCode Go weekly usage limit reached for this session.",
    "OpenCode Go 5 hour and weekly usage limits reached.",
  ])("waits for the latest window %s names while usage lags", (message) => {
    expect(openCodeGoLimitResetAt(message, usage({ rolling: 40, weekly: 98, monthly: 30 }))).toBe(
      WEEKLY_RESET,
    );
  });

  it("uses the spent windows when the error does not name one", () => {
    expect(
      openCodeGoLimitResetAt(
        "Subscription quota exceeded.",
        usage({ rolling: 100, weekly: 60, monthly: 30 }),
      ),
    ).toBe(ROLLING_RESET);
  });

  it("has no reset when no window is named or spent", () => {
    expect(
      openCodeGoLimitResetAt(
        "Subscription quota exceeded.",
        usage({ rolling: 90, weekly: 60, monthly: 30 }),
      ),
    ).toBeNull();
    expect(
      openCodeGoLimitResetAt("OpenCode Go 5 hour usage limit reached.", {
        checkedAt: "2026-11-06T01:49:10.000Z",
        windows: [],
        unavailable: { reason: "probeFailed" },
      }),
    ).toBeNull();
  });
});
