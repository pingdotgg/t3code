import { assert, it } from "@effect/vitest";

import {
  applyCodexConfigModelDefaults,
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

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

it("uses an explicitly configured custom Codex model", () => {
  const models = applyCodexConfigModelDefaults(
    [
      { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
      { slug: "custom-codex", name: "custom-codex", isCustom: true, capabilities: null },
    ],
    { model: "custom-codex" },
  );

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "custom-codex");
});

it("uses the effective Codex config for model, reasoning, and service tier defaults", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "low",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: false,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
    ],
    supportedReasoningEfforts: [
      { description: "Fast", reasoningEffort: "low" },
      { description: "Thorough", reasoningEffort: "high" },
    ],
  });
  const models = applyCodexConfigModelDefaults(
    [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: false,
        isDefault: true,
        capabilities,
      },
      {
        slug: "gpt-test",
        name: "GPT Test",
        isCustom: false,
        capabilities,
      },
    ],
    {
      model: "gpt-test",
      reasoningEffort: "high",
      serviceTier: "priority",
    },
  );

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-sol", isDefault: undefined },
      { slug: "gpt-test", isDefault: true },
    ],
  );
  assert.deepStrictEqual(models[1]?.capabilities?.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
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
          isDefault: true,
        },
      ],
      currentValue: "priority",
    },
  ]);
});

it("applies supported Codex options when the configured model is unavailable", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "low",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT-5.6 Sol",
    hidden: false,
    id: "gpt-5.6-sol",
    isDefault: false,
    model: "gpt-5.6-sol",
    serviceTiers: [],
    supportedReasoningEfforts: [
      { description: "Fast", reasoningEffort: "low" },
      { description: "Thorough", reasoningEffort: "high" },
    ],
  });
  const models = applyCodexConfigModelDefaults(
    [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isCustom: false,
        capabilities,
      },
    ],
    { model: "gpt-unavailable", reasoningEffort: "high" },
  );

  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[0]?.capabilities?.optionDescriptors?.[0]?.currentValue, "high");
});
