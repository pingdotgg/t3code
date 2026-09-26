import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  appendCustomCodexModels,
  applyPreferredCodexDefaultModel,
  CodexModelListWithAccessPrograms,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const modelForAccessTest = {
  additionalSpeedTiers: [],
  defaultReasoningEffort: "high",
  description: "Test model",
  displayName: "GPT Test",
  hidden: false,
  id: "gpt-test",
  isDefault: true,
  model: "gpt-test",
  supportedReasoningEfforts: [{ description: "High", reasoningEffort: "high" }],
};
const decodeCodexModelListWithAccessPrograms = Schema.decodeUnknownSync(
  CodexModelListWithAccessPrograms,
);

it("keeps caller-specific access programs from model discovery", () => {
  const response = decodeCodexModelListWithAccessPrograms({
    data: [
      {
        ...modelForAccessTest,
        availableAccessPrograms: { cyber: ["standard", "daybreakBlue", "daybreakRed"] },
      },
    ],
    nextCursor: null,
  });
  assert.deepStrictEqual(mapCodexModelCapabilities(response.data[0]!).optionDescriptors?.at(-1), {
    id: "cyberAccessProgram",
    label: "Daybreak",
    type: "select",
    options: [
      { id: "standard", label: "Off", isDefault: true },
      { id: "daybreakRed", label: "Red" },
      { id: "daybreakBlue", label: "Blue" },
    ],
    currentValue: "standard",
  });
});

it.each([
  { name: "null", value: null },
  { name: "a primitive", value: "daybreakBlue" },
  { name: "an array", value: ["standard", "daybreakBlue"] },
  { name: "a non-array cyber field", value: { cyber: "daybreakBlue" } },
  { name: "object cyber entries", value: { cyber: [{ id: "daybreakBlue" }] } },
  { name: "mixed cyber entries", value: { cyber: ["standard", "daybreakBlue", null] } },
])("preserves model discovery when access programs contain $name", ({ value }) => {
  const response = decodeCodexModelListWithAccessPrograms({
    data: [
      { ...modelForAccessTest, availableAccessPrograms: value },
      {
        ...modelForAccessTest,
        id: "gpt-daybreak",
        model: "gpt-daybreak",
        availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
      },
    ],
    nextCursor: null,
  });
  assert.deepStrictEqual(
    response.data.map((model) => model.model),
    ["gpt-test", "gpt-daybreak"],
  );
  assert.deepStrictEqual(
    mapCodexModelCapabilities(response.data[0]!),
    mapCodexModelCapabilities(modelForAccessTest),
  );
  assert.equal(
    mapCodexModelCapabilities(response.data[1]!).optionDescriptors?.some(
      (descriptor) => descriptor.id === "cyberAccessProgram",
    ),
    true,
  );
});

it("uses On and Off when the account has one Daybreak program", () => {
  for (const program of ["daybreakBlue", "daybreakRed"]) {
    const daybreak = mapCodexModelCapabilities({
      ...modelForAccessTest,
      availableAccessPrograms: { cyber: ["standard", program] },
    }).optionDescriptors?.find((descriptor) => descriptor.id === "cyberAccessProgram");
    assert.deepStrictEqual(daybreak?.type === "select" ? daybreak.options : [], [
      { id: "standard", label: "Off", isDefault: true },
      { id: program, label: "On" },
    ]);
  }
});

it("hides Daybreak when access is absent for the account or model", () => {
  for (const model of [
    modelForAccessTest,
    {
      ...modelForAccessTest,
      model: "gpt-6-astra",
      availableAccessPrograms: { cyber: ["standard"] },
    },
    {
      ...modelForAccessTest,
      model: "experimental-red-only-alias",
      availableAccessPrograms: { cyber: ["daybreakRed"] },
    },
  ]) {
    assert.equal(
      mapCodexModelCapabilities(model).optionDescriptors?.some(
        (descriptor) => descriptor.id === "cyberAccessProgram",
      ),
      false,
    );
  }
});

it("does not give unverified custom models a built-in model's Daybreak access", () => {
  const builtInCapabilities = mapCodexModelCapabilities({
    ...modelForAccessTest,
    availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
  });
  const custom = appendCustomCodexModels(
    [{ slug: "gpt-test", name: "GPT Test", isCustom: false, capabilities: builtInCapabilities }],
    ["custom-model"],
  );
  assert.equal(
    custom[1]?.capabilities?.optionDescriptors?.some(
      (descriptor) => descriptor.id === "cyberAccessProgram",
    ),
    false,
  );
  const explicitlyConfigured = appendCustomCodexModels(
    [{ slug: "gpt-test", name: "GPT Test", isCustom: false, capabilities: builtInCapabilities }],
    [{ slug: "custom-model", capabilities: builtInCapabilities }],
  );
  assert.equal(
    explicitlyConfigured[1]?.capabilities?.optionDescriptors?.some(
      (descriptor) => descriptor.id === "cyberAccessProgram",
    ),
    false,
  );
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
