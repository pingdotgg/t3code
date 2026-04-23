import { describe, expect, it } from "vitest";

import {
  PRICING_TABLE,
  UNKNOWN_MODEL_PRICING,
  computeTurnCost,
  formatUsd,
  getPricing,
} from "./pricing.ts";

describe("pricing/getPricing", () => {
  it("resolves canonical Claude slug", () => {
    const p = getPricing("claude-sonnet-4-6");
    expect(p.provider).toBe("claudeAgent");
    expect(p.inputPerMTok).toBe(3);
    expect(p.cachedInputPerMTok).toBe(0.3);
    expect(p.outputPerMTok).toBe(15);
    // Anthropic cache-write = 1.25× input.
    expect(p.cacheCreationInputPerMTok).toBeCloseTo(3 * 1.25, 6);
  });

  it("defaults OpenAI cacheCreation rate to input rate", () => {
    const p = getPricing("gpt-5.4");
    expect(p.cacheCreationInputPerMTok).toBe(p.inputPerMTok);
  });

  it("resolves Claude short alias via provider", () => {
    const p = getPricing("sonnet", "claudeAgent");
    expect(p.provider).toBe("claudeAgent");
    expect(p.inputPerMTok).toBe(3);
  });

  it("resolves Codex canonical slug", () => {
    const p = getPricing("gpt-5.4");
    expect(p.provider).toBe("codex");
    expect(p.inputPerMTok).toBe(1.25);
    expect(p.outputPerMTok).toBe(10);
  });

  it("resolves Codex spark as mini tier", () => {
    const p = getPricing("gpt-5.3-codex-spark");
    expect(p.outputPerMTok).toBe(2);
  });

  it("falls back to zero-rate for unknown model", () => {
    const p = getPricing("llama-7b-xyz");
    expect(p).toEqual(UNKNOWN_MODEL_PRICING);
  });

  it("falls back for empty / null model", () => {
    expect(getPricing(null)).toEqual(UNKNOWN_MODEL_PRICING);
    expect(getPricing("")).toEqual(UNKNOWN_MODEL_PRICING);
    expect(getPricing("   ")).toEqual(UNKNOWN_MODEL_PRICING);
  });

  it("defaults reasoningOutput rate to output rate", () => {
    for (const pricing of PRICING_TABLE.values()) {
      expect(pricing.reasoningOutputPerMTok).toBe(pricing.outputPerMTok);
    }
  });
});

describe("pricing/computeTurnCost", () => {
  it("computes Claude Sonnet turn cost correctly", () => {
    const cost = computeTurnCost("claude-sonnet-4-6", {
      inputTokens: 10_000,
      cachedInputTokens: 100_000,
      cacheCreationInputTokens: 20_000,
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
    });
    // 10k * $3/Mtok = $0.03
    expect(cost.inputUsd).toBeCloseTo(0.03, 6);
    // 100k * $0.30/Mtok = $0.03
    expect(cost.cachedUsd).toBeCloseTo(0.03, 6);
    // 20k * ($3 * 1.25 = $3.75)/Mtok = $0.075
    expect(cost.cacheCreationUsd).toBeCloseTo(0.075, 6);
    // 2k * $15/Mtok = $0.03
    expect(cost.outputUsd).toBeCloseTo(0.03, 6);
    // 500 * $15/Mtok = $0.0075
    expect(cost.reasoningUsd).toBeCloseTo(0.0075, 6);
    expect(cost.totalUsd).toBeCloseTo(0.1725, 6);
  });

  it("computes Codex GPT-5.4 turn cost correctly", () => {
    const cost = computeTurnCost("gpt-5.4", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 50_000,
    });
    // 1M * $1.25 = $1.25
    expect(cost.inputUsd).toBeCloseTo(1.25, 6);
    expect(cost.cachedUsd).toBe(0);
    expect(cost.cacheCreationUsd).toBe(0);
    // 100k * $10/Mtok = $1
    expect(cost.outputUsd).toBeCloseTo(1, 6);
    // 50k * $10/Mtok = $0.5
    expect(cost.reasoningUsd).toBeCloseTo(0.5, 6);
    expect(cost.totalUsd).toBeCloseTo(2.75, 6);
  });

  it("applies Anthropic cache-write premium correctly", () => {
    // Pure cache-creation: 1M tokens at 1.25× base rate
    const cost = computeTurnCost("claude-sonnet-4-6", {
      cacheCreationInputTokens: 1_000_000,
    });
    expect(cost.cacheCreationUsd).toBeCloseTo(3 * 1.25, 6);
    expect(cost.totalUsd).toBeCloseTo(3.75, 6);
  });

  it("returns zero cost for unknown model", () => {
    const cost = computeTurnCost("fake-model", {
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(cost.totalUsd).toBe(0);
  });

  it("ignores negative / non-finite deltas", () => {
    const cost = computeTurnCost("claude-sonnet-4-6", {
      inputTokens: -100,
      outputTokens: Number.NaN,
      cachedInputTokens: Number.POSITIVE_INFINITY,
      reasoningOutputTokens: 0,
    });
    expect(cost.totalUsd).toBe(0);
  });

  it("handles missing fields", () => {
    const cost = computeTurnCost("claude-sonnet-4-6", { outputTokens: 1_000 });
    expect(cost.outputUsd).toBeCloseTo(0.015, 6);
    expect(cost.inputUsd).toBe(0);
    expect(cost.cachedUsd).toBe(0);
    expect(cost.reasoningUsd).toBe(0);
    expect(cost.totalUsd).toBeCloseTo(0.015, 6);
  });
});

describe("pricing/formatUsd", () => {
  it("formats zero + invalid", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(null)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(-1)).toBe("$0.00");
  });

  it("formats sub-cent", () => {
    expect(formatUsd(0.002)).toBe("<$0.01");
  });

  it("formats cents with 3 digits trimmed", () => {
    expect(formatUsd(0.125)).toBe("$0.125");
    expect(formatUsd(0.12)).toBe("$0.12");
  });

  it("formats 2-digit dollars", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("formats large dollars rounded", () => {
    expect(formatUsd(1234.56)).toBe("$1,235");
  });
});
