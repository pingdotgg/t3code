import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { cacheHitRate, costPerMillionTokens, usageEmptyState } from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});

it("waits for reconnecting environments before declaring usage empty", () => {
  const answered = { summary: { contractVersion: USAGE_CONTRACT_VERSION }, error: null };
  const reconnecting = { summary: null, error: null };
  const failed = { summary: null, error: "Could not report usage" };
  const selection = { hasUsage: false, loading: false, allProvidersHidden: false };
  expect(usageEmptyState({ ...selection, environments: [answered, reconnecting] })).toBe("pending");
  expect(usageEmptyState({ ...selection, environments: [answered] })).toBe("empty");
  expect(usageEmptyState({ ...selection, environments: [failed] })).toBe("unavailable");
  expect(usageEmptyState({ ...selection, environments: [failed], allProvidersHidden: true })).toBe(
    "hidden",
  );
});
