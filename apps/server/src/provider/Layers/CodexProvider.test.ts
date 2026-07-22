import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  parseCodexModelListResponse,
  toCodexShortName,
} from "./CodexProvider.ts";

it("derives concise names for Codex-owned GPT models", () => {
  assert.strictEqual(toCodexShortName("GPT-5.6-Sol"), "5.6 Sol");
  assert.strictEqual(toCodexShortName("GPT-5.6-Terra"), "5.6 Terra");
  assert.strictEqual(toCodexShortName("GPT-5.4-Mini"), "5.4 Mini");
  assert.strictEqual(toCodexShortName("GPT-5.5"), "5.5");
  assert.strictEqual(toCodexShortName("GPT-4o"), "4o");
  assert.strictEqual(toCodexShortName("GPT-4o-Mini"), "4o Mini");
  assert.strictEqual(toCodexShortName("GPT-5.3-Codex-Spark"), "5.3 Codex Spark");
  assert.strictEqual(toCodexShortName("o3"), "o3");
});

it("preserves unknown catalog suffixes", () => {
  assert.strictEqual(toCodexShortName("GPT-5.6-My_Model"), "GPT-5.6-My_Model");
});

it("derives short names only for recognized raw catalog display names", () => {
  const [model, customModel] = parseCodexModelListResponse({
    data: [
      {
        additionalSpeedTiers: [],
        defaultReasoningEffort: "medium",
        defaultServiceTier: null,
        description: "Test model",
        displayName: "gpt-5.4-mini",
        hidden: false,
        id: "gpt-5.4-mini",
        isDefault: false,
        model: "gpt-5.4-mini",
        serviceTiers: [],
        supportedReasoningEfforts: [],
      },
      {
        additionalSpeedTiers: [],
        defaultReasoningEffort: "medium",
        defaultServiceTier: null,
        description: "Custom model",
        displayName: "GPT-5.6-My_Model",
        hidden: false,
        id: "gpt-5.6-my_model",
        isDefault: false,
        model: "gpt-5.6-my_model",
        serviceTiers: [],
        supportedReasoningEfforts: [],
      },
    ],
  });

  assert.strictEqual(model?.name, "GPT-5.4-Mini");
  assert.strictEqual(model?.shortName, "5.4 Mini");
  assert.strictEqual(customModel?.name, "GPT-5.6-My_Model");
  assert.strictEqual(customModel?.shortName, undefined);
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
