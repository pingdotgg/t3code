import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay, getDescriptorStringValue } from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });

  // Shaped like Devin over ACP, whose speed option carries its own id.
  it.each([
    { currentValue: "fast", speedLabel: "Fast", label: "Medium Fast" },
    { currentValue: "standard", speedLabel: null, label: "Medium · Standard" },
  ])("reads an agent speed option as the speed tier: $currentValue", (input) => {
    expect(
      buildTraitsTriggerDisplay({
        descriptors: [
          {
            id: "thought_level",
            label: "Thinking",
            type: "select",
            role: "reasoning",
            currentValue: "medium",
            options: [{ id: "medium", label: "Medium" }],
          },
          {
            id: "speed",
            label: "Speed",
            type: "select",
            currentValue: input.currentValue,
            options: [
              { id: "standard", label: "Standard" },
              { id: "fast", label: "Fast" },
            ],
          },
        ],
        primarySelectDescriptorId: "thought_level",
        ultrathinkPromptControlled: false,
      }),
    ).toEqual({ label: input.label, speedLabel: input.speedLabel, ultracode: false });
  });
});
