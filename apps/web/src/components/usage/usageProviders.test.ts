import { describe, expect, it } from "vite-plus/test";

import { rankProvidersByMetric } from "./usageProviders";

const totals = [
  { provider: "codex" as const, totalTokens: 520, costUsd: 354.75 },
  { provider: "claude" as const, totalTokens: 3710, costUsd: 2058.43 },
  { provider: "grok" as const, totalTokens: 1, costUsd: 0.89 },
  { provider: "opencode" as const, totalTokens: 189, costUsd: 19.96 },
  { provider: "antigravity" as const, totalTokens: 523, costUsd: 37.42 },
];
const providers = totals.map((entry) => entry.provider);

describe("rankProvidersByMetric", () => {
  it("ranks providers by tokens, highest first", () => {
    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual([
      "claude",
      "antigravity",
      "codex",
      "opencode",
      "grok",
    ]);
  });

  it("ranks providers by cost, highest first", () => {
    expect(rankProvidersByMetric(providers, totals, "cost")).toEqual([
      "claude",
      "codex",
      "antigravity",
      "opencode",
      "grok",
    ]);
  });

  it("keeps the stable provider order for ties and leaves the input alone", () => {
    const tied = [
      { provider: "codex" as const, totalTokens: 10, costUsd: 1 },
      { provider: "claude" as const, totalTokens: 10, costUsd: 1 },
    ];
    const input = ["codex", "claude"] as const;
    expect(rankProvidersByMetric(input, tied, "tokens")).toEqual(["codex", "claude"]);
    expect(input).toEqual(["codex", "claude"]);
  });
});
