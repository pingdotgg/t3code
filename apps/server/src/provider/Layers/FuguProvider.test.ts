/**
 * Fugu reuses Codex app-server model capability mapping. These tests pin the
 * high/xhigh-only reasoning descriptors Fugu models advertise.
 */
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { FuguSettings } from "@t3tools/contracts";

import { mapCodexModelCapabilities } from "./CodexProvider.ts";

const decodeFuguSettings = Schema.decodeSync(FuguSettings);

it("decodes FuguSettings defaults (real codex binary + dedicated home)", () => {
  const settings = decodeFuguSettings({});
  assert.strictEqual(settings.enabled, true);
  assert.strictEqual(settings.binaryPath, "codex");
  assert.strictEqual(settings.homePath, "~/.codex/fugu-home");
  assert.deepStrictEqual(settings.customModels, []);
});

it("maps Fugu high/xhigh reasoning efforts from the catalog descriptors", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "high",
    description: "Go-to balance model",
    displayName: "Fugu",
    hidden: false,
    id: "fugu",
    isDefault: true,
    model: "fugu",
    defaultServiceTier: null,
    serviceTiers: [],
    supportedReasoningEfforts: [
      { description: "High", reasoningEffort: "high" },
      { description: "Extra high", reasoningEffort: "xhigh" },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High" },
      ],
      currentValue: "high",
    },
  ]);
});

it("maps Fugu Ultra with xhigh as the default reasoning effort", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "xhigh",
    description: "Complex tasks",
    displayName: "Fugu Ultra",
    hidden: false,
    id: "fugu-ultra",
    isDefault: false,
    model: "fugu-ultra",
    defaultServiceTier: null,
    serviceTiers: [],
    supportedReasoningEfforts: [
      { description: "High", reasoningEffort: "high" },
      { description: "Extra high", reasoningEffort: "xhigh" },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High", isDefault: true },
      ],
      currentValue: "xhigh",
    },
  ]);
});
