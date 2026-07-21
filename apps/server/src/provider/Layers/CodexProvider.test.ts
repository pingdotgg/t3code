import { assert, it } from "@effect/vitest";

import { appendCustomCodexModels, mapCodexModelCapabilities } from "./CodexProvider.ts";

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

it("adds Max to custom models that inherit a Codex reasoning selector", () => {
  const models = appendCustomCodexModels(
    [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: mapCodexModelCapabilities({
          additionalSpeedTiers: [],
          defaultReasoningEffort: "xhigh",
          defaultServiceTier: null,
          description: "Test model",
          displayName: "GPT-5.4",
          hidden: false,
          id: "gpt-5.4",
          isDefault: true,
          model: "gpt-5.4",
          serviceTiers: [],
          supportedReasoningEfforts: [
            { description: "Low reasoning", reasoningEffort: "low" },
            { description: "Medium reasoning", reasoningEffort: "medium" },
            { description: "High reasoning", reasoningEffort: "high" },
            { description: "Extra high reasoning", reasoningEffort: "xhigh" },
          ],
        }),
      },
    ],
    ["gpt-5.6-terra-gwc"],
  );

  assert.deepStrictEqual(
    models[1]?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoningEffort",
    ),
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High", isDefault: true },
        { id: "max", label: "Max" },
      ],
      currentValue: "xhigh",
    },
  );
});
