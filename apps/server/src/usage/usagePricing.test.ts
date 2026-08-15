import { describe, expect, it } from "@effect/vitest";

import {
  lookupRate,
  mergeRateTables,
  normalizeModelName,
  parseOpenCodeRates,
  parseRateTable,
  type RateTable,
} from "./usagePricing.ts";

describe("parseOpenCodeRates", () => {
  it("projects models.dev costs into per-token rates keyed by providerID/modelID", () => {
    const table = parseOpenCodeRates({
      "opencode-go": {
        models: {
          "deepseek-v4-flash": { cost: { input: 0.07, output: 0.14, cache_read: 0.0014 } },
        },
      },
      opencode: {
        models: {
          "deepseek-v4-flash": { cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } },
        },
      },
    });

    const go = table.get("opencode-go/deepseek-v4-flash");
    const zen = table.get("opencode/deepseek-v4-flash");
    expect(go?.inputCostPerToken).toBeCloseTo(0.07e-6, 12);
    expect(go?.outputCostPerToken).toBeCloseTo(0.14e-6, 12);
    expect(go?.cacheReadCostPerToken).toBeCloseTo(0.0014e-6, 15);
    // The same model id under two subscriptions must not collapse.
    expect(zen?.inputCostPerToken).toBeCloseTo(0.14e-6, 12);
  });

  it("falls back to the input rate when a model omits cache pricing", () => {
    const table = parseOpenCodeRates({
      "opencode-go": { models: { "kimi-k3": { cost: { input: 3, output: 15 } } } },
    });

    const rate = table.get("opencode-go/kimi-k3");
    expect(rate?.cacheReadCostPerToken).toBe(rate?.inputCostPerToken);
    expect(rate?.cacheCreationCostPerToken).toBe(rate?.inputCostPerToken);
  });

  it("keeps zero-cost free models priced at zero rather than unpriced", () => {
    const table = parseOpenCodeRates({
      opencode: { models: { "deepseek-v4-flash-free": { cost: { input: 0, output: 0 } } } },
    });

    expect(table.get("opencode/deepseek-v4-flash-free")).toEqual({
      inputCostPerToken: 0,
      outputCostPerToken: 0,
      cacheReadCostPerToken: 0,
      cacheCreationCostPerToken: 0,
    });
  });

  it("ignores foreign providers and half-priced entries", () => {
    const table = parseOpenCodeRates({
      anthropic: { models: { "claude-sonnet-4-5": { cost: { input: 3, output: 15 } } } },
      "opencode-go": { models: { half: { cost: { input: 1 } } } },
    });

    expect(table.size).toBe(0);
  });
});

describe("lookupRate", () => {
  const table: RateTable = new Map([
    [
      "opencode-go/deepseek-v4-flash",
      {
        inputCostPerToken: 0.07e-6,
        outputCostPerToken: 0.14e-6,
        cacheReadCostPerToken: 0.0014e-6,
        cacheCreationCostPerToken: 0.07e-6,
      },
    ],
    [
      "claude-fable-5",
      {
        inputCostPerToken: 1e-5,
        outputCostPerToken: 5e-5,
        cacheReadCostPerToken: 1e-6,
        cacheCreationCostPerToken: 1.25e-5,
      },
    ],
  ]);

  it("prefers the exact qualified name over the stripped fallback", () => {
    expect(lookupRate(table, "opencode-go/deepseek-v4-flash")?.inputCostPerToken).toBeCloseTo(
      0.07e-6,
      12,
    );
  });

  it("strips a provider/ prefix for bare model names", () => {
    expect(lookupRate(table, "anthropic/claude-fable-5")?.inputCostPerToken).toBe(1e-5);
    expect(normalizeModelName("anthropic/claude-fable-5")).toBe("claude-fable-5");
  });

  it("returns null for unknown models", () => {
    expect(lookupRate(table, "opencode-go/nope")).toBeNull();
  });
});

describe("mergeRateTables", () => {
  it("overlays the opencode rates so its models win on conflict", () => {
    const base: RateTable = new Map([
      [
        "deepseek-v4-flash",
        {
          inputCostPerToken: 0.5e-6,
          outputCostPerToken: 1e-6,
          cacheReadCostPerToken: 0.5e-6,
          cacheCreationCostPerToken: 0.5e-6,
        },
      ],
    ]);
    const opencode = parseOpenCodeRates({
      "opencode-go": { models: { "deepseek-v4-flash": { cost: { input: 0.07, output: 0.14 } } } },
    });

    const merged = mergeRateTables(base, opencode);
    expect(merged.get("opencode-go/deepseek-v4-flash")).toEqual(
      opencode.get("opencode-go/deepseek-v4-flash"),
    );
    expect(merged.get("deepseek-v4-flash")?.inputCostPerToken).toBe(0.5e-6);
  });
});

describe("parseRateTable", () => {
  it("strips LiteLLM provider prefixes when keying", () => {
    const table = parseRateTable({
      "anthropic/claude-fable-5": {
        input_cost_per_token: 1e-5,
        output_cost_per_token: 5e-5,
      },
    });

    expect(table.get("claude-fable-5")).not.toBeUndefined();
  });
});
