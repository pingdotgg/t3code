import { describe, expect, it } from "vite-plus/test";

import {
  lookupRate,
  normalizeModelName,
  parseRateTable,
  priceUsage,
} from "./usagePricing.ts";

const EMPTY_TOTALS = {
  uncachedInputTokens: 1_000_000,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 1_000_000,
  reasoningTokens: 0,
};

describe("parseRateTable", () => {
  it("drops zero/zero LiteLLM rows so they cannot mask Cursor auto rates", () => {
    const table = parseRateTable({
      "openrouter/openrouter/auto": {
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
      "claude-sonnet-4-5": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
      },
    });

    expect(table.has("auto")).toBe(false);
    expect(table.get("claude-sonnet-4-5")?.inputCostPerToken).toBe(3e-6);
  });
});

describe("lookupRate", () => {
  const table = parseRateTable({
    "claude-sonnet-4-5": {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_read_input_token_cost: 3e-7,
      cache_creation_input_token_cost: 3.75e-6,
    },
    "claude-opus-5": {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 2.5e-5,
    },
    "claude-opus-4-6": {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 2.5e-5,
    },
    "gpt-5.5": {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 3e-5,
      cache_read_input_token_cost: 5e-7,
    },
    "gpt-5.3-codex": {
      input_cost_per_token: 1.75e-6,
      output_cost_per_token: 1.4e-5,
    },
  });

  it("prices Cursor Auto Cost flat rates", () => {
    const rate = lookupRate(table, "auto");
    expect(rate?.inputCostPerToken).toBeCloseTo(1.25 / 1_000_000);
    expect(rate?.outputCostPerToken).toBeCloseTo(6 / 1_000_000);
    expect(rate?.cacheReadCostPerToken).toBeCloseTo(0.25 / 1_000_000);
  });

  it("prices Composer and Grok from Cursor docs", () => {
    expect(lookupRate(table, "composer-2.5-fast")?.inputCostPerToken).toBeCloseTo(3 / 1_000_000);
    expect(lookupRate(table, "composer-2.5")?.inputCostPerToken).toBeCloseTo(0.5 / 1_000_000);
    expect(lookupRate(table, "cursor-grok-4.5-high-fast")?.inputCostPerToken).toBeCloseTo(
      4 / 1_000_000,
    );
    expect(lookupRate(table, "cursor-grok-4.5-high")?.inputCostPerToken).toBeCloseTo(2 / 1_000_000);
  });

  it("does not strip Composer Fast down to standard Composer rates", () => {
    expect(lookupRate(new Map(), "composer-2.5-fast")?.inputCostPerToken).toBeCloseTo(
      3 / 1_000_000,
    );
  });

  it("maps Cursor Claude/GPT export slugs onto LiteLLM ids", () => {
    expect(lookupRate(table, "claude-4.5-sonnet")?.inputCostPerToken).toBe(3e-6);
    expect(lookupRate(table, "claude-opus-5-thinking-high")?.inputCostPerToken).toBe(5e-6);
    expect(lookupRate(table, "claude-4.6-opus-high-thinking")?.inputCostPerToken).toBe(5e-6);
    expect(lookupRate(table, "gpt-5.5-medium")?.inputCostPerToken).toBe(5e-6);
    expect(lookupRate(table, "gpt-5.3-codex-high")?.inputCostPerToken).toBe(1.75e-6);
  });

  it("prefers provider-reported dollars when present", () => {
    const priced = priceUsage(table, "auto", EMPTY_TOTALS, 0.19);
    expect(priced).toEqual({ costUsd: 0.19, costSource: "providerReported" });
  });

  it("leaves unknown Cursor tooling models unpriced", () => {
    expect(lookupRate(table, "premium")).toBeNull();
    expect(lookupRate(table, "agent_review")).toBeNull();
    expect(normalizeModelName("OpenAI/GPT-5.5")).toBe("gpt-5.5");
  });
});
