import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  pendingModelAfterPress,
  usesInlineSelectChoices,
  visibleSheetOptionDescriptors,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "Codex",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });
});

const reasoning: ProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

const contextWindow: ProviderOptionDescriptor = {
  id: "contextWindow",
  label: "Context Window",
  type: "select",
  options: [
    { id: "200k", label: "200k", isDefault: true },
    { id: "1m", label: "1M" },
  ],
  currentValue: "200k",
};

const fastMode: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast Mode",
  type: "boolean",
  currentValue: false,
};

describe("visible sheet option descriptors", () => {
  it("keeps only the advertised options, dropping empty select catalogs", () => {
    const emptySelect: ProviderOptionDescriptor = {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [{ id: "ultracode", label: "Ultracode" }],
      currentValue: "ultracode",
    };

    expect(
      visibleSheetOptionDescriptors([reasoning, fastMode, emptySelect]).map(
        (descriptor) => descriptor.id,
      ),
    ).toEqual(["effort", "fastMode"]);
  });

  it("uses inline chips for short catalogs and a disclosure for long ones", () => {
    expect(usesInlineSelectChoices(reasoning)).toBe(true);
    expect(usesInlineSelectChoices(contextWindow)).toBe(true);

    const longCatalog: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "modelVariant",
      label: "Variant",
      type: "select",
      options: Array.from({ length: 8 }, (_, index) => ({
        id: `v${index}`,
        label: `Variant ${index}`,
      })),
    };
    expect(usesInlineSelectChoices(longCatalog)).toBe(false);
  });
});
