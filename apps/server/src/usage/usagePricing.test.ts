import { describe, expect, it } from "@effect/vitest";

import {
  cacheSavingsUsd,
  cacheWriteUsd,
  createOverrideRateTable,
  lookupRate,
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
  const totals = {
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 500_000,
  };

  it("uses custom token rates ahead of public and provider-reported costs", () => {
    const table = parseRateTable({ "example-model": rate(1) });
    const overrides = createOverrideRateTable({
      "example-model": {
        inputCostPerMillionTokens: 2,
        outputCostPerMillionTokens: 8,
        cacheReadCostPerMillionTokens: 0.5,
        cacheWriteCostPerMillionTokens: 3,
      },
    });

    for (const reportedCostUsd of [null, 99]) {
      expect(priceUsage(table, "example-model", totals, reportedCostUsd, overrides)).toEqual({
        costUsd: 13.5,
        costSource: "modelPriced",
      });
    }
    expect(cacheSavingsUsd(table, "example-model", totals, overrides)).toBe(1.5);
  });

  it("prices unknown models offline and uses input prices for omitted cache rates", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
    });

    expect(priceUsage(table, "example-model", totals, null, overrides)).toEqual({
      costUsd: 14,
      costSource: "modelPriced",
    });
    expect(cacheSavingsUsd(table, "example-model", totals, overrides)).toBe(0);
  });

  it("preserves explicit zero rates and matches only the exact trimmed model ID", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      " vendor/example-model[1m] ": {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      },
    });
    expect(priceUsage(table, " vendor/example-model[1m] ", totals, 99, overrides)).toEqual({
      costUsd: 0,
      costSource: "modelPriced",
    });
    for (const model of [
      "example-model[1m]",
      "vendor/example-model",
      "vendor/Example-model[1m]",
      "other/example-model[1m]",
    ]) {
      expect(priceUsage(table, model, totals, null, overrides).costSource).toBe("unpriced");
      expect(priceUsage(table, model, totals, 99, overrides)).toEqual({
        costUsd: 99,
        costSource: "providerReported",
      });
    }
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

  it("prices a bracketed context-tier variant at the base model's rate", () => {
    const table = parseRateTable({ "claude-fable-5-1": rate(1e-5, 2.5e-7) });

    expect(lookupRate(table, "claude-fable-5-1[1m]")).toEqual(
      lookupRate(table, "claude-fable-5-1"),
    );
    expect(lookupRate(table, "anthropic/Claude-Fable-5-1[1m]")).toBeNull();
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
