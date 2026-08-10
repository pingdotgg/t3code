import { describe, expect, it } from "@effect/vitest";

import {
  lookupRate,
  parseRateTable,
  priceUsage,
  resolvePricingModelKey,
} from "./usagePricing.ts";

const EMPTY_TOTALS = {
  uncachedInputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 1_000_000,
  reasoningTokens: 0,
};

describe("parseRateTable", () => {
  it("skips zero/zero stubs that would hide real supplement rates", () => {
    const table = parseRateTable({
      "openrouter/openrouter/auto": {
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
      "claude-sonnet-4-6": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
      },
    });

    expect(table.has("auto")).toBe(false);
    expect(table.get("claude-sonnet-4-6")?.inputCostPerToken).toBe(3e-6);
  });
});

describe("resolvePricingModelKey", () => {
  it("maps Cursor CSV slugs onto canonical pricing keys", () => {
    expect(resolvePricingModelKey("auto")).toBe("auto");
    expect(resolvePricingModelKey("default")).toBe("auto");
    expect(resolvePricingModelKey("composer-2.5-fast")).toBe("composer-2.5-fast");
    expect(resolvePricingModelKey("claude-4.6-opus-high-thinking")).toBe("claude-opus-4-6");
    expect(resolvePricingModelKey("claude-4.6-sonnet-medium-thinking")).toBe("claude-sonnet-4-6");
    expect(resolvePricingModelKey("gpt-5.4-high-fast")).toBe("gpt-5.4-fast");
  });
});

describe("lookupRate / priceUsage", () => {
  it("prices Cursor auto from the supplement, not LiteLLM's $0 stub", () => {
    const table = parseRateTable({
      "openrouter/openrouter/auto": {
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
    });

    const rate = lookupRate(table, "auto");
    expect(rate).not.toBeNull();
    expect(rate?.inputCostPerToken).toBeCloseTo(1.25 / 1_000_000, 12);

    const priced = priceUsage(table, "Auto", EMPTY_TOTALS, null);
    expect(priced.costSource).toBe("modelPriced");
    // 1M input @ $1.25/M + 1M output @ $6/M
    expect(priced.costUsd).toBeCloseTo(7.25, 6);
  });

  it("prices Composer and Cursor CSV Claude slugs", () => {
    const table = parseRateTable({
      "claude-opus-4-6": {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
        cache_read_input_token_cost: 0.5e-6,
        cache_creation_input_token_cost: 6.25e-6,
      },
    });

    expect(lookupRate(table, "composer-2.5-fast")?.outputCostPerToken).toBeCloseTo(
      15 / 1_000_000,
      12,
    );

    const priced = priceUsage(table, "claude-4.6-opus-high-thinking", EMPTY_TOTALS, null);
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(30, 6);
  });

  it("applies a fast multiplier when only the base model is known", () => {
    const table = parseRateTable({
      "gpt-5.4": {
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 15e-6,
        cache_read_input_token_cost: 0.25e-6,
      },
    });

    // Alias strips effort+fast down to gpt-5.4, then we need the -fast path.
    // Direct lookup of a remaining -fast key uses the multiplier.
    const rate = lookupRate(table, "gpt-5.4-fast");
    expect(rate?.inputCostPerToken).toBeCloseTo(5e-6, 12);
    expect(rate?.outputCostPerToken).toBeCloseTo(30e-6, 12);
  });
});
