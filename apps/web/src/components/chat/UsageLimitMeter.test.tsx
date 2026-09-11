import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { UsageLimitsSnapshot } from "~/lib/usageLimits";
import { UsageLimitMeter } from "./UsageLimitMeter";

const NOW = Date.parse("2026-03-23T12:00:00.000Z");

function makeSnapshot(overrides: Partial<UsageLimitsSnapshot> = {}): UsageLimitsSnapshot {
  return {
    provider: "claudeAgent",
    status: "ok",
    windows: [
      {
        id: "five_hour",
        usedPercent: 42,
        resetsAt: "2026-03-23T14:10:00.000Z",
        windowDurationMins: 300,
        updatedAt: "2026-03-23T11:00:00.000Z",
      },
    ],
    planType: null,
    credits: null,
    overage: null,
    spendLimit: null,
    limitReason: null,
    updatedAt: "2026-03-23T11:00:00.000Z",
    ...overrides,
  };
}

describe("UsageLimitMeter", () => {
  it("describes the headline window in the trigger label", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitMeter usage={makeSnapshot()} providerDisplayName="Claude" nowMs={NOW} />,
    );

    expect(markup).toContain('aria-label="Session usage limit 42% used, resets in 2h 10m"');
  });

  it("flags a reached limit in the trigger label", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitMeter
        usage={makeSnapshot({ status: "limited", limitReason: "rate_limit_reached" })}
        nowMs={NOW}
      />,
    );

    expect(markup).toContain('aria-label="Usage limit reached, resets in 2h 10m"');
  });
});
