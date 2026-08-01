import { assert, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  parseCodexModelListResponse,
} from "./CodexProvider.ts";

const catalogModel = (
  overrides: Partial<CodexSchema.V2ModelListResponse__Model> &
    Pick<CodexSchema.V2ModelListResponse__Model, "model">,
): CodexSchema.V2ModelListResponse__Model => ({
  additionalSpeedTiers: [],
  defaultReasoningEffort: "medium",
  description: "Test model",
  displayName: overrides.model,
  hidden: false,
  id: overrides.model,
  isDefault: false,
  supportedReasoningEfforts: [],
  ...overrides,
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

it("keeps selectable models from the catalog", () => {
  const models = parseCodexModelListResponse({
    data: [
      catalogModel({ model: "gpt-5.6-sol", displayName: "gpt-5.6-sol", isDefault: true }),
      catalogModel({ model: "gpt-5.6-luna", displayName: "gpt-5.6-luna" }),
    ],
  });

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, name: model.name, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isDefault: true },
      { slug: "gpt-5.6-luna", name: "GPT-5.6-Luna", isDefault: undefined },
    ],
  );
});

it("drops catalog models the app server marks as hidden", () => {
  const models = parseCodexModelListResponse({
    data: [
      catalogModel({ model: "gpt-5.6-sol" }),
      catalogModel({ model: "gpt-5.6-internal", hidden: true }),
    ],
  });

  assert.deepStrictEqual(
    models.map((model) => model.slug),
    ["gpt-5.6-sol"],
  );
});

it("drops non-interactive Codex models even when they are not marked hidden", () => {
  // codex-cli 0.145.0 reports codex-auto-review with hidden: false and the
  // display name of another model, so it appears as a duplicate picker row.
  const models = parseCodexModelListResponse({
    data: [
      catalogModel({ model: "codex-auto-review", displayName: "gpt-5.6-luna" }),
      catalogModel({ model: "gpt-5.6-luna", displayName: "gpt-5.6-luna" }),
    ],
  });

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, name: model.name })),
    [{ slug: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
