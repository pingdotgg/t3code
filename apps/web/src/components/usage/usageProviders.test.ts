import { USAGE_CONTRACT_VERSION, USAGE_MERGE_COMPATIBLE_SINCE } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compatibleUsageSources, rankProvidersByMetric } from "./usageProviders";

describe("Usage provider sources", () => {
  it("only retains sources whose contract versions can contribute to merged totals", () => {
    const sources = compatibleUsageSources([
      { summary: { contractVersion: USAGE_CONTRACT_VERSION, sources: ["current"] } },
      { summary: { contractVersion: USAGE_MERGE_COMPATIBLE_SINCE, sources: ["older"] } },
      { summary: { contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1, sources: ["too-old"] } },
      { summary: { contractVersion: USAGE_CONTRACT_VERSION + 1, sources: ["too-new"] } },
      { summary: null },
    ]);
    expect(sources).toEqual(["current", "older"]);
  });
});

describe("rankProvidersByMetric", () => {
  it("ranks by the selected metric, highest first", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 100, costUsd: 20 },
      { provider: "claude" as const, totalTokens: 200, costUsd: 10 },
    ];
    const providers = ["codex", "claude"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["claude", "codex"]);
    expect(rankProvidersByMetric(providers, totals, "cost")).toEqual(["codex", "claude"]);
  });

  it("keeps ties in input order without reordering the shared provider list", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 10, costUsd: 1 },
      { provider: "claude" as const, totalTokens: 10, costUsd: 1 },
      { provider: "grok" as const, totalTokens: 20, costUsd: 2 },
    ];
    const providers = ["claude", "codex", "grok"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["grok", "claude", "codex"]);
    expect(providers).toEqual(["claude", "codex", "grok"]);
  });
});
