import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type SelectProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  resolveDefaultChoiceId,
} from "./modelTraits.ts";

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
        provider: ProviderDriverKind.make("pi"),
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });
});

const claude = ProviderInstanceId.make("claudeAgent");
const effort: SelectProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};
const opus = { instanceId: claude, model: "claude-opus-5-5" };

describe("resolveDefaultChoiceId", () => {
  it("marks the configured default's level, falling back to the provider's default", () => {
    const configured = (instanceId: ProviderInstanceId, model: string, value: string) =>
      createModelSelection(instanceId, model, [{ id: "effort", value }]);
    const work = ProviderInstanceId.make("claudeAgent_work");

    expect(resolveDefaultChoiceId(effort, opus, configured(claude, opus.model, "high"))).toBe(
      "high",
    );
    expect(
      resolveDefaultChoiceId(effort, opus, configured(claude, "claude-fable-5-1", "high")),
    ).toBe("medium");
    expect(resolveDefaultChoiceId(effort, opus, configured(work, opus.model, "high"))).toBe(
      "medium",
    );
    expect(resolveDefaultChoiceId(effort, opus, configured(claude, opus.model, "ultrathink"))).toBe(
      "medium",
    );
  });
});
