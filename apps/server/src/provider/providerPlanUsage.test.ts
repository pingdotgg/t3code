import { describe, expect, it } from "vite-plus/test";

import { normalizeClaudePlanUsage, normalizeCodexPlanUsage } from "./providerPlanUsage.ts";

const checkedAt = "2026-08-24T18:00:00.000Z";

describe("provider plan usage", () => {
  it("normalizes Codex primary and weekly windows", () => {
    expect(
      normalizeCodexPlanUsage(
        {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_777_000_000 },
            secondary: { usedPercent: 72, windowDurationMins: 10_080, resetsAt: 1_777_500_000 },
          },
        },
        checkedAt,
      ),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "codex:primary",
          label: "5-hour",
          usedPercent: 31,
          resetsAt: "2026-04-24T03:06:40.000Z",
          windowDurationMinutes: 300,
        },
        {
          id: "codex:secondary",
          label: "Weekly",
          usedPercent: 72,
          resetsAt: "2026-04-29T22:00:00.000Z",
          windowDurationMinutes: 10_080,
        },
      ],
    });
  });

  it("keeps named Codex buckets distinct and clamps percentages", () => {
    const usage = normalizeCodexPlanUsage(
      {
        rateLimitsByLimitId: {
          codex: { limitName: "Codex", primary: { usedPercent: -1 } },
          codex_fast: { limitName: "Fast", primary: { usedPercent: 120 } },
        },
      },
      checkedAt,
    );

    expect(usage?.windows).toEqual([
      {
        id: "codex:primary",
        label: "Primary",
        usedPercent: 0,
        resetsAt: null,
      },
      {
        id: "codex_fast:primary",
        label: "Fast · Primary",
        usedPercent: 100,
        resetsAt: null,
      },
    ]);
  });

  it("normalizes Claude all-models and forward-compatible Fable windows", () => {
    expect(
      normalizeClaudePlanUsage(
        {
          seven_day: { utilization: 10, resets_at: "2026-08-29T01:00:00Z" },
          seven_day_fable: { utilization: 18, resets_at: "2026-08-29T01:00:00Z" },
          extra_usage: { utilization: 70 },
        },
        checkedAt,
      ),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "seven_day",
          label: "All models",
          usedPercent: 10,
          resetsAt: "2026-08-29T01:00:00.000Z",
          windowDurationMinutes: 10_080,
        },
        {
          id: "seven_day_fable",
          label: "Fable",
          usedPercent: 18,
          resetsAt: "2026-08-29T01:00:00.000Z",
          windowDurationMinutes: 10_080,
        },
      ],
    });
  });

  it("omits unavailable and malformed usage", () => {
    expect(normalizeCodexPlanUsage({}, checkedAt)).toBeUndefined();
    expect(normalizeClaudePlanUsage(null, checkedAt)).toBeUndefined();
    expect(
      normalizeClaudePlanUsage({ seven_day: { utilization: "10" } }, checkedAt),
    ).toBeUndefined();
  });
});
