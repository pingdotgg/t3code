import { describe, expect, it } from "vite-plus/test";

import { parseGrokUsageLimitsOutput } from "./grokTuiUsageProbe.ts";

describe("grokTuiUsageProbe", () => {
  it("parses weekly limit and next reset from Grok /usage show output", () => {
    const checkedAt = "2026-07-07T12:00:00.000Z";
    const parsed = parseGrokUsageLimitsOutput({
      checkedAt,
      output: `
        Usage
        Show    Manage
        Weekly limit: 32%
        Next reset: July 11, 02:10 PT
      `,
    });

    expect(parsed.available).toBe(true);
    expect(parsed.source).toBe("grokStatusProbe");
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]).toMatchObject({
      kind: "weekly",
      label: "Weekly",
      usedPercent: 32,
      windowDurationMins: 7 * 24 * 60,
    });
    expect(parsed.windows[0]?.resetsAt).toBeDefined();
  });

  it("returns unavailable when weekly limit text is absent", () => {
    expect(
      parseGrokUsageLimitsOutput({
        checkedAt: "2026-07-07T12:00:00.000Z",
        output: "Show    Manage",
      }),
    ).toEqual({
      source: "grokStatusProbe",
      available: false,
      checkedAt: "2026-07-07T12:00:00.000Z",
      reason: "Usage limits unavailable for this Grok account.",
      windows: [],
    });
  });
});
