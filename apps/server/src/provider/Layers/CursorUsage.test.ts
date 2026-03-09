import { assert, describe, it } from "@effect/vitest";

import { parseCursorUsageQuota } from "./CursorUsage.ts";

const RESET_DATE = new Date(1772906400000).toISOString();

describe("CursorUsage", () => {
  it("maps current period usage into a sidebar quota", () => {
    const quota = parseCursorUsageQuota({
      planInfo: {
        planInfo: {
          planName: "Pro",
        },
      },
      currentPeriod: {
        billingCycleEnd: "1772906400000",
        planUsage: {
          totalPercentUsed: 29.38888888888889,
        },
      },
      billingCycle: {
        endDateEpochMillis: "1772906400000",
      },
    });

    assert.deepStrictEqual(quota, {
      plan: "Pro",
      percentUsed: 29.38888888888889,
      resetDate: RESET_DATE,
    });
  });

  it("falls back to billing cycle metadata when the current period omits a reset time", () => {
    const quota = parseCursorUsageQuota({
      planInfo: {
        planInfo: {
          planName: "Pro",
        },
      },
      currentPeriod: {
        planUsage: {
          totalPercentUsed: 58.6,
        },
      },
      billingCycle: {
        endDateEpochMillis: "1772906400000",
      },
    });

    assert.deepStrictEqual(quota, {
      plan: "Pro",
      percentUsed: 58.6,
      resetDate: RESET_DATE,
    });
  });

  it("returns undefined when Cursor does not expose a usable percent", () => {
    const quota = parseCursorUsageQuota({
      planInfo: {
        planInfo: {
          planName: "Pro",
        },
      },
      currentPeriod: {
        planUsage: {},
      },
    });

    assert.strictEqual(quota, undefined);
  });
});
