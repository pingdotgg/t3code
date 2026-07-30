import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_HERMES_MODEL,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayRequestId,
} from "@t3tools/contracts";

import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import {
  decodeHermesModelSlug,
  encodeHermesModelSlug,
  hermesServerModels,
} from "./hermesModels.ts";

describe("Hermes model slugs", () => {
  it("round-trips provider-qualified ids without delimiter collisions", () => {
    const slug = encodeHermesModelSlug({
      provider: "custom:local/proxy",
      model: "anthropic/claude-sonnet-4:extended",
    });

    expect(decodeHermesModelSlug(slug)).toEqual({
      mode: "specific",
      provider: "custom:local/proxy",
      model: "anthropic/claude-sonnet-4:extended",
    });
    expect(decodeHermesModelSlug(DEFAULT_HERMES_MODEL)).toEqual({ mode: "default" });
    expect(decodeHermesModelSlug("unknown-model")).toBeUndefined();
    expect(decodeHermesModelSlug("hermes-model:provider")).toBeUndefined();
    expect(decodeHermesModelSlug("hermes-model:%E0%A4%A:model")).toBeUndefined();
  });
});

describe("hermesServerModels", () => {
  it("keeps the legacy default and exposes provider-qualified catalog choices", () => {
    const models = hermesServerModels({
      reportedModel: "fallback-model",
      catalog: {
        type: "models.list.response",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: HermesGatewayRequestId.make("models-1"),
        currentProvider: "openrouter",
        currentModel: "anthropic/claude-sonnet-4",
        currentReasoningEffort: "high",
        reasoningEfforts: ["none", "low", "high"],
        models: [
          {
            provider: "openrouter",
            providerName: "OpenRouter",
            model: "anthropic/claude-sonnet-4",
            supportsReasoning: true,
          },
          {
            provider: "anthropic",
            providerName: "Anthropic",
            model: "claude-haiku-4-5",
            supportsReasoning: false,
          },
          {
            provider: "openrouter",
            providerName: "OpenRouter",
            model: "openai/gpt-5.4",
            supportsReasoning: true,
          },
        ],
      },
    });

    expect(models.map((model) => model.name)).toEqual([
      "anthropic/claude-sonnet-4 (Hermes default)",
      "anthropic/claude-sonnet-4",
      "claude-haiku-4-5",
      "openai/gpt-5.4",
    ]);
    expect(models[0]?.slug).toBe(DEFAULT_HERMES_MODEL);
    const reasoningDescriptor = models[0]?.capabilities?.optionDescriptors?.[0];
    expect(reasoningDescriptor).toMatchObject({
      id: "reasoningEffort",
      options: [
        { id: "none", label: "None" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });
    expect(reasoningDescriptor).not.toHaveProperty("currentValue");
    expect(
      reasoningDescriptor?.type === "select"
        ? reasoningDescriptor.options.some((option) => option.isDefault)
        : true,
    ).toBe(false);
    expect(
      buildProviderOptionSelectionsFromDescriptors(models[0]?.capabilities?.optionDescriptors),
    ).toBeUndefined();
    const explicitDescriptors = getProviderOptionDescriptors({
      caps: models[0]!.capabilities!,
      selections: [{ id: "reasoningEffort", value: "low" }],
    });
    expect(buildProviderOptionSelectionsFromDescriptors(explicitDescriptors)).toEqual([
      { id: "reasoningEffort", value: "low" },
    ]);
    expect(decodeHermesModelSlug(models[1]?.slug ?? "")).toEqual({
      mode: "specific",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(models[2]?.capabilities?.optionDescriptors).toEqual([]);
    expect(decodeHermesModelSlug(models[3]?.slug ?? "")).toEqual({
      mode: "specific",
      provider: "openrouter",
      model: "openai/gpt-5.4",
    });
  });

  it("still exposes reasoning on the default when inventory degrades", () => {
    const [fallback] = hermesServerModels({ reportedModel: "gpt-5", catalog: undefined });
    expect(fallback?.slug).toBe(DEFAULT_HERMES_MODEL);
    expect(fallback?.capabilities?.optionDescriptors).toEqual([]);
  });
});
