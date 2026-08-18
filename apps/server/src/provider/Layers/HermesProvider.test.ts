import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildHermesDiscoveredModelsFromSessionModelState,
  hermesModelsFromSettings,
  hermesSlashCommands,
  parseHermesVersion,
} from "./HermesProvider.ts";

describe("Hermes provider metadata", () => {
  it("reads the product version instead of Hermes' release date", () => {
    expect(parseHermesVersion("Hermes Agent v0.20.0 (2026.8.3)")).toBe("0.20.0");
  });

  it("marks Hermes' configured model as the live default", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "openrouter:anthropic/claude-sonnet-4.6",
      availableModels: [
        {
          modelId: "openrouter:anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
        },
        { modelId: "openai:gpt-5.4", name: "GPT-5.4" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map(({ slug, isDefault }) => ({ slug, isDefault }))).toEqual([
      { slug: "openrouter:anthropic/claude-sonnet-4.6", isDefault: true },
      { slug: "openai:gpt-5.4", isDefault: undefined },
    ]);
  });

  it("keeps the built-in default entry when Hermes routes through its default model", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "default",
      availableModels: [
        {
          modelId: "openrouter:anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
        },
        { modelId: "openai:gpt-5.4", name: "GPT-5.4" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map(({ slug, isDefault }) => ({ slug, isDefault }))).toEqual([
      { slug: "default", isDefault: true },
      { slug: "openrouter:anthropic/claude-sonnet-4.6", isDefault: undefined },
      { slug: "openai:gpt-5.4", isDefault: undefined },
    ]);
  });

  it("merges exact provider:model custom ids without duplicates", () => {
    const models = hermesModelsFromSettings([
      " openrouter:anthropic/claude-sonnet-4.6 ",
      "openrouter:anthropic/claude-sonnet-4.6",
    ]);
    expect(models.map((model) => model.slug)).toEqual([
      "default",
      "openrouter:anthropic/claude-sonnet-4.6",
    ]);
  });

  it("normalizes advertised slash command names and hints", () => {
    expect(
      hermesSlashCommands([
        { name: "/model", description: "Switch model", input: { hint: "provider:model" } },
      ]),
    ).toEqual([{ name: "model", description: "Switch model", input: { hint: "provider:model" } }]);
  });
});
