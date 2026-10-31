import { assert, it } from "@effect/vitest";

import {
  appendCustomCodexModels,
  applyPreferredCodexDefaultModel,
  applyConfiguredCodexCyberAccess,
  codexDefaultCyberAccessProgram,
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
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
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
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
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

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("defaults cyber access to Standard when the catalog offers it", () => {
  const model = {
    additionalSpeedTiers: [],
    defaultReasoningEffort: "medium",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    supportedReasoningEfforts: [],
  };
  const cyber = (programs?: ReadonlyArray<"standard" | "daybreakBlue">) =>
    mapCodexModelCapabilities({
      ...model,
      ...(programs ? { availableAccessPrograms: { cyber: [...programs] } } : {}),
    }).optionDescriptors?.[0];

  assert.strictEqual(cyber(), undefined);
  assert.deepStrictEqual(cyber(["standard", "daybreakBlue"]), {
    id: "cyberAccessProgram",
    label: "Cyber Access",
    type: "select",
    options: [
      { id: "standard", label: "Standard", isDefault: true },
      { id: "daybreakBlue", label: "Daybreak Blue" },
    ],
    currentValue: "standard",
  });
  assert.deepInclude(cyber(["standard"]), { currentValue: "standard" });
  assert.deepInclude(cyber(["daybreakBlue"]), { currentValue: "daybreakBlue" });
});

it("finds the default cyber access program for a model", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
    defaultReasoningEffort: "medium",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    supportedReasoningEfforts: [],
  });
  const models = [{ slug: "gpt-test", name: "GPT Test", isCustom: false, capabilities }];
  assert.strictEqual(codexDefaultCyberAccessProgram(models, "gpt-test"), "standard");
  assert.strictEqual(codexDefaultCyberAccessProgram(models, "my-model"), undefined);
});

it("follows Codex's daybreak setting for the default program", () => {
  const capabilities = (cyber: ReadonlyArray<"standard" | "daybreakBlue">) =>
    mapCodexModelCapabilities({
      additionalSpeedTiers: [],
      availableAccessPrograms: { cyber: [...cyber] },
      defaultReasoningEffort: "medium",
      description: "Test model",
      displayName: "GPT Test",
      hidden: false,
      id: "gpt-test",
      isDefault: true,
      model: "gpt-test",
      supportedReasoningEfforts: [],
    });
  const models = [
    {
      slug: "both",
      name: "Both",
      isCustom: false,
      capabilities: capabilities(["standard", "daybreakBlue"]),
    },
    {
      slug: "standard",
      name: "Standard",
      isCustom: false,
      capabilities: capabilities(["standard"]),
    },
  ];

  const on = applyConfiguredCodexCyberAccess(models, {
    daybreakEnabled: true,
    apiKeyProgramsDisabled: false,
  });
  assert.strictEqual(codexDefaultCyberAccessProgram(on, "both"), "daybreakBlue");
  assert.strictEqual(codexDefaultCyberAccessProgram(on, "standard"), "standard");

  const disabled = applyConfiguredCodexCyberAccess(models, {
    daybreakEnabled: false,
    apiKeyProgramsDisabled: true,
  });
  assert.strictEqual(codexDefaultCyberAccessProgram(disabled, "both"), undefined);
});

it("keeps Daybreak access off custom models that borrow built-in options", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
    defaultReasoningEffort: "medium",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
  });
  const models = appendCustomCodexModels(
    [{ slug: "gpt-test", name: "GPT Test", isCustom: false, capabilities }],
    [{ slug: "my-model" }],
  );

  const optionIds = (slug: string) =>
    models
      .find((model) => model.slug === slug)
      ?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id);
  assert.deepStrictEqual(optionIds("gpt-test"), ["reasoningEffort", "cyberAccessProgram"]);
  assert.deepStrictEqual(optionIds("my-model"), ["reasoningEffort"]);
});
