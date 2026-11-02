import { describe, expect, it } from "@effect/vitest";

import { cursorRateModel } from "@t3tools/provider-cursor/server/accountUsage";
import type { UsageSpeed } from "@t3tools/provider-core/server/usage";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  parseRateTable,
  priceUsage,
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
  const record = (
    model: string,
    reportedCostUsd: number | null = null,
    speed: UsageSpeed = "standard",
  ) => ({
    model,
    totals,
    reportedCostUsd,
    speed,
  });

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
      expect(priceUsage(table, record("example-model", reportedCostUsd), overrides)).toMatchObject({
        costUsd: 13.5,
        costSource: "modelPriced",
      });
    }
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(1.5);
  });

  it("prices Cursor cache savings at the base model rate", () => {
    const table = parseRateTable({
      "claude-fable-5-1": rate(10e-6, 1e-6),
      "xai/grok-4.7": rate(2e-6, 0.5e-6),
      "openrouter/x-ai/grok-4.7": rate(3e-6, 0.5e-6),
    });
    const cursorRecord = (model: string) => ({
      ...record(model, 0.25),
      rateModel: cursorRateModel(model),
    });

    expect(cacheSavingsUsd(table, cursorRecord("claude-fable-5-1-thinking-high"))).toBeCloseTo(9);
    expect(cacheSavingsUsd(table, cursorRecord("cursor-grok-4.7-high-fast"))).toBeCloseTo(1.5);
    expect(cacheSavingsUsd(table, cursorRecord("default"))).toBe(0);
    expect(priceUsage(table, cursorRecord("grok-4.7-xhigh-fast"))).toMatchObject({
      costUsd: 0.25,
      costSource: "providerReported",
    });
  });

  it("prices unknown models offline and uses input prices for omitted cache rates", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
    });

    expect(priceUsage(table, record("example-model"), overrides)).toMatchObject({
      costUsd: 14,
      costSource: "modelPriced",
    });
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(0);
  });

  it("preserves explicit zero rates and matches only the exact trimmed model ID", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      " vendor/example-model[1m] ": {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      },
    });
    expect(priceUsage(table, record(" vendor/example-model[1m] ", 99), overrides)).toMatchObject({
      costUsd: 0,
      costSource: "modelPriced",
    });
    for (const model of [
      "example-model[1m]",
      "vendor/example-model",
      "vendor/Example-model[1m]",
      "other/example-model[1m]",
    ]) {
      expect(priceUsage(table, record(model), overrides).costSource).toBe("unpriced");
      expect(priceUsage(table, record(model, 99), overrides)).toEqual({
        costUsd: 99,
        costSource: "providerReported",
        categoryCostUsd: null,
        speedPremiumUsd: 0,
      });
    }
  });

  it("prices fast-mode requests at the model's published fast multiple", () => {
    const table = parseRateTable({
      "claude-opus-5-5": { ...rate(4e-6, 2e-7), provider_specific_entry: { fast: 2, us: 1.1 } },
      "claude-fable-5-1": { ...rate(1e-5, 2.5e-7), provider_specific_entry: { us: 1.1 } },
    });
    const overrides = createOverrideRateTable({
      "claude-opus-5-5": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 20 },
    });
    const cost = (model: string, speed: UsageSpeed, custom?: typeof overrides) =>
      priceUsage(table, record(model, null, speed), custom).costUsd;

    expect(cost("claude-opus-5-5", "fast")).toBeCloseTo(2 * cost("claude-opus-5-5", "standard"));
    expect(cacheSavingsUsd(table, record("claude-opus-5-5", null, "fast"))).toBeCloseTo(
      2 * cacheSavingsUsd(table, record("claude-opus-5-5")),
    );
    expect(cost("claude-fable-5-1", "fast")).toBe(cost("claude-fable-5-1", "standard"));
    expect(cost("claude-opus-5-5", "fast", overrides)).toBe(
      cost("claude-opus-5-5", "standard", overrides),
    );
  });

  it("splits cost by category and prices the speed premium", () => {
    const table = parseRateTable({
      "claude-opus-5-5": {
        ...rate(4e-6, 4e-7),
        cache_creation_input_token_cost: 5e-6,
        provider_specific_entry: { fast: 2 },
      },
    });
    const split = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
      input: expect.closeTo(input),
      cacheRead: expect.closeTo(cacheRead),
      cacheWrite: expect.closeTo(cacheWrite),
      output: expect.closeTo(output),
    });

    expect(priceUsage(table, record("claude-opus-5-5", null, "fast"))).toEqual({
      costUsd: expect.closeTo(58.8),
      costSource: "modelPriced",
      categoryCostUsd: split(8, 0.8, 10, 40),
      speedPremiumUsd: expect.closeTo(29.4),
    });
    expect(priceUsage(table, record("claude-opus-5-5", 29.4, "fast"))).toEqual({
      costUsd: 29.4,
      costSource: "providerReported",
      categoryCostUsd: split(4, 0.4, 5, 20),
      speedPremiumUsd: expect.closeTo(14.7),
    });
    expect(priceUsage(table, record("unknown-model", 29.4, "fast"))).toMatchObject({
      costUsd: 29.4,
      categoryCostUsd: null,
      speedPremiumUsd: 0,
    });
  });

  it("prices Codex priority and ultrafast requests at their published tier rates", () => {
    const table = parseRateTable({
      "gpt-6-astra": {
        ...rate(1e-5, 1e-6),
        input_cost_per_token_priority: 2e-5,
        output_cost_per_token_priority: 1e-4,
        cache_read_input_token_cost_priority: 2e-6,
        input_cost_per_token_ultrafast: 6e-5,
        output_cost_per_token_ultrafast: 3e-4,
      },
      "gpt-6-sol": rate(2e-6, 2e-7),
    });
    const cost = (model: string, speed: UsageSpeed) =>
      priceUsage(table, record(model, null, speed)).costUsd;
    const standard = cost("gpt-6-astra", "standard");

    expect(cost("gpt-6-astra", "fast")).toBeCloseTo(2 * standard);
    expect(cost("gpt-6-astra", "ultrafast")).toBeCloseTo(6 * standard);
    expect(cacheSavingsUsd(table, record("gpt-6-astra", null, "ultrafast"))).toBeCloseTo(
      6 * cacheSavingsUsd(table, record("gpt-6-astra")),
    );
    expect(cost("gpt-6-sol", "ultrafast")).toBe(cost("gpt-6-sol", "standard"));
  });

  it("prices a request above the model's long-context threshold at its above-tier rates", () => {
    const table = parseRateTable({
      "claude-haiku-5-5": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
        cache_read_input_token_cost: 1e-7,
        cache_creation_input_token_cost: 1.25e-6,
        input_cost_per_token_above_100k_tokens: 2e-6,
        output_cost_per_token_above_100k_tokens: 7.5e-6,
        cache_read_input_token_cost_above_100k_tokens: 2e-7,
        cache_creation_input_token_cost_above_100k_tokens: 2.5e-6,
      },
      "gpt-6-sol": {
        ...rate(2e-6, 2e-7),
        input_cost_per_token_priority: 4e-6,
        output_cost_per_token_priority: 2e-5,
        cache_read_input_token_cost_priority: 4e-7,
        input_cost_per_token_above_272k_tokens_priority: 8e-6,
        output_cost_per_token_above_272k_tokens_priority: 3e-5,
        cache_read_input_token_cost_above_272k_tokens_priority: 8e-7,
      },
    });
    const longRequest = (
      model: string,
      speed: UsageSpeed,
      totals: { uncached: number; cacheRead: number; cacheWrite: number; output: number },
    ) => ({
      model,
      speed,
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: totals.uncached,
        cachedInputTokens: totals.cacheRead,
        cacheCreationTokens: totals.cacheWrite,
        outputTokens: totals.output,
        reasoningTokens: 0,
      },
    });

    // The Claude prompt is input + cache read + cache write: 120K, above the 100K tier.
    expect
      .soft(
        priceUsage(
          table,
          longRequest("claude-haiku-5-5", "standard", {
            uncached: 10_000,
            cacheRead: 100_000,
            cacheWrite: 10_000,
            output: 1_000,
          }),
        ).costUsd,
      )
      .toBeCloseTo(10_000 * 2e-6 + 100_000 * 2e-7 + 10_000 * 2.5e-6 + 1_000 * 7.5e-6, 12);
    expect(
      priceUsage(
        table,
        longRequest("gpt-6-sol", "fast", {
          uncached: 20_000,
          cacheRead: 280_000,
          cacheWrite: 0,
          output: 1_000,
        }),
      ).costUsd,
    ).toBeCloseTo(20_000 * 8e-6 + 280_000 * 8e-7 + 1_000 * 3e-5, 12);
  });

  it("bills the long-context tier only above its threshold, filling missing tier fields from base", () => {
    const table = parseRateTable({
      "gpt-6-sol": {
        input_cost_per_token: 2e-6,
        output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 2e-7,
        input_cost_per_token_priority: 4e-6,
        output_cost_per_token_priority: 2e-5,
        input_cost_per_token_above_272k_tokens: 4e-6,
      },
    });
    const cost = (prompt: number, speed: UsageSpeed = "standard") =>
      priceUsage(table, {
        model: "gpt-6-sol",
        speed,
        reportedCostUsd: null,
        totals: {
          uncachedInputTokens: prompt - 200_000,
          cachedInputTokens: 200_000,
          cacheCreationTokens: 0,
          outputTokens: 1_000,
          reasoningTokens: 0,
        },
      }).costUsd;

    expect(cost(272_000)).toBeCloseTo(72_000 * 2e-6 + 200_000 * 2e-7 + 1_000 * 1e-5, 12);
    // Output keeps the base rate; cache reads keep the base discount relative to input.
    expect(cost(272_001)).toBeCloseTo(72_001 * 4e-6 + 200_000 * 4e-7 + 1_000 * 1e-5, 12);
    // Without a priority long-context rate, priority requests keep the priority rate.
    expect(cost(272_001, "fast")).toBeCloseTo(72_001 * 4e-6 + 200_000 * 4e-7 + 1_000 * 2e-5, 12);
  });

  it("leaves price overrides and models without above-tier rates at their flat rates", () => {
    const table = parseRateTable({ "gpt-6-sol": rate(2e-6) });
    const overrides = createOverrideRateTable({
      "claude-haiku-5-5": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 5 },
    });
    const long = (model: string) => ({
      model,
      speed: "standard" as const,
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 500_000,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    });

    expect(priceUsage(table, long("gpt-6-sol")).costUsd).toBeCloseTo(1, 12);
    expect(priceUsage(table, long("claude-haiku-5-5"), overrides).costUsd).toBeCloseTo(0.5, 12);
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

  it("keeps a bare alias when a reseller entry omits the fast tier", () => {
    const table = parseRateTable({
      "provider-a/example-model": {
        ...rate(1),
        input_cost_per_token_priority: 2,
        output_cost_per_token_priority: 10,
      },
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
});
