import { describe, expect, it } from "@effect/vitest";

import { lookupRate, type ModelRate, type RateTable } from "./usagePricing.ts";

const blueRate: ModelRate = {
  inputCostPerToken: 5e-6,
  outputCostPerToken: 3e-5,
  cacheReadCostPerToken: 5e-7,
  cacheCreationCostPerToken: 6.25e-6,
};
const redRate: ModelRate = {
  inputCostPerToken: 1.25e-5,
  outputCostPerToken: 7.5e-5,
  cacheReadCostPerToken: 1.25e-6,
  cacheCreationCostPerToken: 1.5625e-5,
};

describe("usage pricing", () => {
  it("resolves Codex Daybreak rollout names to LiteLLM rates", () => {
    const rates: RateTable = new Map([
      ["daybreak-blue-latest", blueRate],
      ["daybreak-red-latest", redRate],
    ]);

    expect(lookupRate(rates, "gpt-daybreak-blue-latest")).toBe(blueRate);
    expect(lookupRate(rates, "gpt-daybreak-red-latest")).toBe(redRate);
  });

  it("prefers an exact rate over a fallback alias", () => {
    const exactRate: ModelRate = { ...blueRate, inputCostPerToken: 1 };
    const rates: RateTable = new Map([
      ["gpt-daybreak-blue-latest", exactRate],
      ["daybreak-blue-latest", blueRate],
    ]);

    expect(lookupRate(rates, "gpt-daybreak-blue-latest")).toBe(exactRate);
  });

  it("keeps unknown models unpriced", () => {
    expect(lookupRate(new Map(), "unknown-model")).toBeNull();
  });
});
