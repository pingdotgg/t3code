/**
 * Fugu reuses Codex app-server model capability mapping. These tests pin the
 * high/xhigh/max reasoning descriptors Fugu models accept.
 */
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { FuguSettings, type ServerProviderModel } from "@t3tools/contracts";

import { mapCodexModelCapabilities } from "./CodexProvider.ts";
import { normalizeFuguModelCapabilities } from "../Drivers/FuguDriver.ts";

const decodeFuguSettings = Schema.decodeSync(FuguSettings);

it("decodes FuguSettings defaults (real codex binary + dedicated home)", () => {
  const settings = decodeFuguSettings({});
  assert.strictEqual(settings.enabled, true);
  assert.strictEqual(settings.binaryPath, "codex");
  assert.strictEqual(settings.homePath, "~/.codex/fugu-home");
  assert.deepStrictEqual(settings.customModels, []);
});

function fuguModel(input: {
  readonly slug: string;
  readonly displayName: string;
  readonly defaultReasoningEffort: string;
  readonly supportedReasoningEfforts: ReadonlyArray<{
    readonly description: string;
    readonly reasoningEffort: string;
  }>;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.displayName,
    isCustom: false,
    capabilities: mapCodexModelCapabilities({
      additionalSpeedTiers: [],
      defaultReasoningEffort: input.defaultReasoningEffort,
      description: input.displayName,
      displayName: input.displayName,
      hidden: false,
      id: input.slug,
      isDefault: input.slug === "fugu",
      model: input.slug,
      defaultServiceTier: null,
      serviceTiers: [],
      supportedReasoningEfforts: input.supportedReasoningEfforts,
    }),
  };
}

it("maps Fugu high/xhigh/max reasoning efforts for the UI", () => {
  const capabilities = normalizeFuguModelCapabilities(
    fuguModel({
      slug: "fugu",
      displayName: "Fugu",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { description: "High", reasoningEffort: "high" },
        { description: "Extra high", reasoningEffort: "xhigh" },
      ],
    }),
  );

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
      ],
      currentValue: "high",
    },
  ]);
});

it("maps Fugu Ultra with xhigh as the default reasoning effort", () => {
  const capabilities = normalizeFuguModelCapabilities(
    fuguModel({
      slug: "fugu-ultra",
      displayName: "Fugu Ultra",
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: [
        { description: "High", reasoningEffort: "high" },
        { description: "Extra high", reasoningEffort: "xhigh" },
      ],
    }),
  );

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High", isDefault: true },
        { id: "max", label: "Max" },
      ],
      currentValue: "xhigh",
    },
  ]);
});

it("falls back from stale medium catalog defaults to a valid Fugu default", () => {
  const capabilities = normalizeFuguModelCapabilities(
    fuguModel({
      slug: "fugu",
      displayName: "Fugu",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { description: "Medium", reasoningEffort: "medium" },
        { description: "High", reasoningEffort: "high" },
        { description: "Extra high", reasoningEffort: "xhigh" },
      ],
    }),
  );

  assert.deepStrictEqual(capabilities.optionDescriptors?.[0], {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    currentValue: "high",
  });
});
