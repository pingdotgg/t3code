import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
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

  it("labels Codex cyber access only when a program is chosen", () => {
    const display = (currentValue: string) =>
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("codex"),
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: false,
        descriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "medium", label: "Medium", isDefault: true }],
            currentValue: "medium",
          },
          {
            id: "cyberAccessProgram",
            label: "Cyber Access",
            type: "select",
            options: [
              { id: "default", label: "Automatic", isDefault: true },
              { id: "daybreakBlue", label: "Daybreak Blue" },
            ],
            currentValue,
          },
        ] satisfies ReadonlyArray<ProviderOptionDescriptor>,
      }).label;

    expect(display("default")).toBe("Medium");
    expect(display("daybreakBlue")).toBe("Medium · Daybreak Blue");
  });
});
