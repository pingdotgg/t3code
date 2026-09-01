import type {
  EnvironmentId,
  UsageDay,
  UsageProviderKind,
  UsageThreadBreakdown,
  UsageThreadRow,
} from "@t3tools/contracts";
import type { EnvironmentProviderContribution } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadBreakdownInput, mergeUsageThreadBreakdowns } from "./usage";

function row(provider: UsageProviderKind, overrides: Partial<UsageThreadRow> = {}): UsageThreadRow {
  return {
    key: "same-key",
    threadId: null,
    title: `${provider} row`,
    provider,
    project: "App",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 30,
      outputTokens: 40,
      reasoningTokens: 5,
    },
    costUsd: 1,
    sessions: 1,
    agents: [],
    daily: [],
    ...overrides,
  };
}

function breakdown(rows: readonly UsageThreadRow[]): UsageThreadBreakdown {
  return {
    contractVersion: 7,
    readAt: "2026-08-28T01:15:00.000Z",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-28" as UsageDay,
    rows,
    truncatedRows: rows.reduce((sum, item) => sum + (item.groupedRows ?? 0), 0),
    scanDurationMs: 1,
  };
}

describe("mergeUsageThreadBreakdowns", () => {
  it("uses the summary's physical-source owner for each provider", () => {
    const environmentA = "env-a" as EnvironmentId;
    const environmentB = "env-b" as EnvironmentId;
    const contributions: readonly EnvironmentProviderContribution[] = [
      { environmentId: environmentA, providers: ["claude"] },
      { environmentId: environmentB, providers: ["codex"] },
    ];
    const merged = mergeUsageThreadBreakdowns(
      [
        {
          environmentId: environmentA,
          breakdown: breakdown([
            row("claude", { groupedRows: 2 }),
            row("codex", { groupedRows: 7 }),
          ]),
        },
        {
          environmentId: environmentB,
          breakdown: breakdown([
            row("claude", { groupedRows: 11 }),
            row("codex", { groupedRows: 3 }),
          ]),
        },
      ],
      contributions,
    );

    expect(merged.rows.map((item) => [item.provider, item.environmentId])).toEqual([
      ["claude", environmentA],
      ["codex", environmentB],
    ]);
    expect(merged.rows.reduce((sum, item) => sum + item.costUsd, 0)).toBe(2);
    expect(merged.truncatedRows).toBe(5);
  });
});

describe("makeThreadBreakdownInput", () => {
  it("preserves exact bounds and limits the environment to its owned providers", () => {
    expect(
      makeThreadBreakdownInput(
        {
          sinceDay: "2026-08-07" as UsageDay,
          untilDay: "2026-08-08" as UsageDay,
          timeZone: "UTC",
          resolution: "hour",
          sinceTime: "2026-08-07T12:00:00.000Z",
          untilTime: "2026-08-08T12:00:00.000Z",
        },
        "id:project-one",
        ["claude"],
      ),
    ).toEqual({
      sinceDay: "2026-08-07",
      untilDay: "2026-08-08",
      timeZone: "UTC",
      sinceTime: "2026-08-07T12:00:00.000Z",
      untilTime: "2026-08-08T12:00:00.000Z",
      projectKey: "id:project-one",
      providers: ["claude"],
    });
  });
});
