import { describe, expect, it } from "@effect/vitest";
import { PRIME_AGENT_DEFAULT_MODEL } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildPrimeAgentModelsFromSession } from "./PrimeAgentProvider.ts";

const modelConfig = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "anthropic/claude-sonnet-4",
  options: [
    { value: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
    { value: "openai/gpt-5", name: "GPT-5" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;

describe("buildPrimeAgentModelsFromSession", () => {
  it("marks the session's current model as default", () => {
    const models = buildPrimeAgentModelsFromSession({ configOptions: [modelConfig] });
    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ]);
    expect(models[0]).toMatchObject({
      isDefault: true,
      aliases: [PRIME_AGENT_DEFAULT_MODEL],
    });
    expect(models[1]?.isDefault).toBeUndefined();
  });

  it("falls back to the models block when no model config option exists", () => {
    const models = buildPrimeAgentModelsFromSession({
      models: {
        currentModelId: "prime-inference/kimi-k2",
        availableModels: [{ modelId: "prime-inference/kimi-k2", name: "Kimi K2" }],
      },
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ slug: "prime-inference/kimi-k2", isDefault: true });
  });

  it("drops blank and duplicate entries", () => {
    const models = buildPrimeAgentModelsFromSession({
      configOptions: [
        {
          ...modelConfig,
          options: [
            { value: "  ", name: "blank" },
            { value: "openai/gpt-5", name: "GPT-5" },
            { value: "openai/gpt-5", name: "GPT-5 duplicate" },
          ],
        },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual(["openai/gpt-5"]);
  });
});
