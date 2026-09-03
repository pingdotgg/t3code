import { describe, expect, it } from "@effect/vitest";

import {
  cacheSavingsUsd,
  cacheWriteUsd,
  lookupRate,
  normalizeModelName,
  parseRateTable,
  priceUsage,
  usageComponentCosts,
} from "./usagePricing.ts";

const rate = (input: number, cacheRead?: number) => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }),
});

describe("usage pricing", () => {
  it("keeps the existing model-name normalization contract", () => {
    expect(normalizeModelName(" Anthropic/Claude-Opus-5 ")).toBe("claude-opus-5");
  });

  it("keeps the canonical Fable rate separate from DeepInfra in either order", () => {
    const canonical = ["claude-fable-5", rate(1e-5, 1e-6)] as const;
    const deepInfra = ["deepinfra/anthropic/claude-fable-5", rate(1e-5)] as const;

    for (const entries of [
      [canonical, deepInfra],
      [deepInfra, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));

      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      expect(lookupRate(table, "other/claude-fable-5")).toBeNull();
    }
  });

  it("adds a bare alias when every qualified entry has the same rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("leaves an ambiguous bare name unpriced", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(3),
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("keeps a bare name ambiguous when only the one-hour cache rate differs", () => {
    const common = {
      input_cost_per_token: 1,
      output_cost_per_token: 5,
      cache_read_input_token_cost: 0.1,
      cache_creation_input_token_cost: 1.25,
    };
    const table = parseRateTable({
      "provider-a/example-model": {
        ...common,
        cache_creation_input_token_cost_above_1hr: 2,
      },
      "provider-b/example-model": {
        ...common,
        cache_creation_input_token_cost_above_1hr: 3,
      },
    });

    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("keeps a bare name ambiguous when a context-length tier differs", () => {
    const common = {
      input_cost_per_token: 1,
      output_cost_per_token: 5,
      input_cost_per_token_above_272k_tokens: 2,
    };
    const table = parseRateTable({
      "provider-a/example-model": {
        ...common,
        output_cost_per_token_above_272k_tokens: 7.5,
      },
      "provider-b/example-model": {
        ...common,
        output_cost_per_token_above_272k_tokens: 10,
      },
    });

    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("cannot price more TTL-specific tokens than total cache creation", () => {
    const table = parseRateTable({
      "example-model": {
        input_cost_per_token: 1,
        output_cost_per_token: 5,
        cache_creation_input_token_cost: 1.25,
        cache_creation_input_token_cost_above_1hr: 2,
      },
    });

    expect(
      cacheWriteUsd(table, "example-model", {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 10,
        cacheCreation5mTokens: 20,
        cacheCreation1hTokens: 20,
        outputTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe(20);
  });

  it("uses the public long-context tier only above its input threshold", () => {
    const table = parseRateTable({
      "gpt-5.6-sol": {
        input_cost_per_token: 4e-6,
        output_cost_per_token: 20e-6,
        cache_read_input_token_cost: 0.4e-6,
        cache_creation_input_token_cost: 5e-6,
        input_cost_per_token_above_272k_tokens: 8e-6,
        output_cost_per_token_above_272k_tokens: 30e-6,
        cache_read_input_token_cost_above_272k_tokens: 0.8e-6,
        cache_creation_input_token_cost_above_272k_tokens: 10e-6,
      },
    });
    const atThreshold = {
      uncachedInputTokens: 1,
      cachedInputTokens: 271_989,
      cacheCreationTokens: 10,
      outputTokens: 2,
      reasoningTokens: 1,
    };
    const aboveThreshold = { ...atThreshold, uncachedInputTokens: 2 };

    expect(priceUsage(table, "gpt-5.6-sol", atThreshold, null).costUsd).toBeCloseTo(
      1 * 4e-6 + 271_989 * 0.4e-6 + 10 * 5e-6 + 2 * 20e-6,
      12,
    );
    expect(priceUsage(table, "gpt-5.6-sol", aboveThreshold, null).costUsd).toBeCloseTo(
      2 * 8e-6 + 271_989 * 0.8e-6 + 10 * 10e-6 + 2 * 30e-6,
      12,
    );
    expect(cacheWriteUsd(table, "gpt-5.6-sol", aboveThreshold)).toBeCloseTo(10 * 10e-6, 12);
    expect(cacheSavingsUsd(table, "gpt-5.6-sol", aboveThreshold)).toBeCloseTo(
      271_989 * (8e-6 - 0.8e-6),
      12,
    );
    expect(usageComponentCosts(table, "gpt-5.6-sol", aboveThreshold)).toEqual({
      cacheWriteUsd: 10 * 10e-6,
      cacheReadUsd: 271_989 * 0.8e-6,
      freshUsd: 2 * 8e-6 + 2 * 30e-6,
    });
  });
});
