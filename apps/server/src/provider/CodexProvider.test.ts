import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  makePendingCodexProvider,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

it.effect("maps Codex capabilities while keeping Daybreak out of custom models", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    availableAccessPrograms: { cyber: ["daybreakRed"] },
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
    {
      id: "cyberAccessProgram",
      label: "Daybreak",
      type: "select",
      options: [{ id: "daybreakRed", label: "Red" }],
    },
  ]);

  return decodeCodexSettings({ customModels: [{ slug: "custom", capabilities }] }).pipe(
    Effect.flatMap(makePendingCodexProvider),
    Effect.map((provider) =>
      assert.deepStrictEqual(
        provider.models[0]?.capabilities?.optionDescriptors,
        capabilities.optionDescriptors?.slice(0, 2),
      ),
    ),
  );
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

it.each([
  [undefined, undefined],
  [null, undefined],
  [[], undefined],
  [["standard"], [{ id: "standard", label: "Off", isDefault: true }]],
  [["daybreakBlue"], [{ id: "daybreakBlue", label: "Blue" }]],
  [["daybreakRed"], [{ id: "daybreakRed", label: "Red" }]],
  [
    ["daybreakRed", "daybreakBlue", "standard"],
    [
      { id: "standard", label: "Off", isDefault: true },
      { id: "daybreakBlue", label: "Blue" },
      { id: "daybreakRed", label: "Red" },
    ],
  ],
  [
    ["standard", "daybreakBlue", "daybreakRed"],
    [
      { id: "standard", label: "Off", isDefault: true },
      { id: "daybreakBlue", label: "Blue" },
      { id: "daybreakRed", label: "Red" },
    ],
  ],
] as const)("maps only advertised Daybreak programs %j", (programs, options) => {
  const model: CodexSchema.V2ModelListResponse__Model = {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "Test",
    description: "Test",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [],
    ...(programs === undefined
      ? {}
      : { availableAccessPrograms: programs === null ? null : { cyber: programs } }),
  };
  const descriptor = mapCodexModelCapabilities(model).optionDescriptors?.find(
    (option) => option.id === "cyberAccessProgram",
  );
  assert.deepEqual(
    descriptor,
    options === undefined
      ? undefined
      : {
          id: "cyberAccessProgram",
          label: "Daybreak",
          type: "select",
          options,
          ...(programs?.some((program) => program === "standard")
            ? { currentValue: "standard" }
            : {}),
        },
  );
});

it.effect(
  "keeps native account access for renamed discovery models and strips custom-only access",
  () =>
    Effect.gen(function* () {
      const capabilities = {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select" as const,
            options: [{ id: "high", label: "High" }],
          },
          {
            id: "cyberAccessProgram",
            label: "Daybreak",
            type: "select" as const,
            options: [{ id: "daybreakBlue", label: "Blue" }],
          },
        ],
      };
      const settings = yield* decodeCodexSettings({
        customModels: [
          { slug: "native", name: "Renamed native", capabilities: { optionDescriptors: [] } },
          "bare-custom",
          { slug: "injected-custom", capabilities },
        ],
      });
      const provider = yield* checkCodexProviderStatus(settings, () =>
        Effect.succeed({
          account: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
          version: "test",
          skills: [],
          models: [{ slug: "native", name: "Native", isCustom: false, capabilities }],
        }),
      );
      assert.deepEqual(
        provider.models.map((model) => ({
          slug: model.slug,
          name: model.name,
          isCustom: model.isCustom,
          descriptors: model.capabilities?.optionDescriptors,
        })),
        [
          {
            slug: "native",
            name: "Renamed native",
            isCustom: false,
            descriptors: capabilities.optionDescriptors,
          },
          {
            slug: "bare-custom",
            name: "bare-custom",
            isCustom: true,
            descriptors: capabilities.optionDescriptors.slice(0, 1),
          },
          {
            slug: "injected-custom",
            name: "injected-custom",
            isCustom: true,
            descriptors: capabilities.optionDescriptors.slice(0, 1),
          },
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
