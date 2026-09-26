import { describe, expect, it } from "@effect/vitest";
import { PRIME_AGENT_DEFAULT_MODEL } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { primeAgentModelOptions, resolvePrimeAgentModel } from "./PrimeAgentAcpSupport.ts";

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "anthropic/claude-sonnet-4",
    options: [
      { value: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
      { value: "openai/gpt-5", name: "GPT-5" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("primeAgentModelOptions", () => {
  it("flattens grouped select options", () => {
    expect(primeAgentModelOptions(configOptions).map((option) => option.value)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ]);
  });

  it("finds a model option by category when its id differs", () => {
    const categorized = [
      { ...configOptions[0]!, id: "prime-model", category: "model" },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    expect(primeAgentModelOptions(categorized).map((option) => option.value)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ]);
    expect(resolvePrimeAgentModel({ configOptions: categorized, model: undefined })).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  it("returns nothing without a model select", () => {
    expect(primeAgentModelOptions([])).toEqual([]);
  });
});

describe("resolvePrimeAgentModel", () => {
  it("keeps the session's current model for an unset selection", () => {
    expect(resolvePrimeAgentModel({ configOptions, model: undefined })).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  it("keeps the session's current model for the product default", () => {
    expect(resolvePrimeAgentModel({ configOptions, model: PRIME_AGENT_DEFAULT_MODEL })).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  it("honors an explicit model", () => {
    expect(resolvePrimeAgentModel({ configOptions, model: "openai/gpt-5" })).toBe("openai/gpt-5");
  });
});
