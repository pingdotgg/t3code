import { describe, expect, it } from "vite-plus/test";

import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { evaluateDailyUsageBudget } from "./usageBudget";

function day(day: string, claudeUsd: number, codexUsd: number): DailyTotals {
  return {
    day,
    costUsd: claudeUsd + codexUsd,
    totalTokens: 0,
    byProvider: new Map([
      ["claude", { costUsd: claudeUsd, totalTokens: 0 }],
      ["codex", { costUsd: codexUsd, totalTokens: 0 }],
    ]),
  };
}

describe("evaluateDailyUsageBudget", () => {
  it("returns the strongest crossing in the visible window", () => {
    expect(
      evaluateDailyUsageBudget(
        [day("2026-08-30", 600, 0), day("2026-08-31", 2_100, 0)],
        "2026-08-31",
      ),
    ).toEqual({
      day: "2026-08-31",
      kind: "claude",
      level: "pause",
      thresholdUsd: 2_000,
      valueUsd: 2_100,
    });
  });

  it("warns on API-equivalent cost even when Claude remains below its limit", () => {
    expect(evaluateDailyUsageBudget([day("2026-08-31", 100, 950)], "2026-08-31")).toMatchObject({
      kind: "apiEquivalent",
      level: "warn",
      valueUsd: 1_050,
    });
  });

  it("returns null below every threshold", () => {
    expect(evaluateDailyUsageBudget([day("2026-08-31", 100, 100)], "2026-08-31")).toBeNull();
  });

  it("does not keep warning about an older day", () => {
    expect(
      evaluateDailyUsageBudget(
        [day("2026-08-30", 2_100, 0), day("2026-08-31", 100, 100)],
        "2026-08-31",
      ),
    ).toBeNull();
  });

  it("does not show yesterday's alert when today has no usage bucket", () => {
    expect(evaluateDailyUsageBudget([day("2026-08-30", 2_100, 0)], "2026-08-31")).toBeNull();
  });
});
