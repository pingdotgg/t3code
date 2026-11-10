import type { ProviderOptionDescriptor, ProviderOptionSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getPromptControlledTraits,
  getTraitSelectChange,
  preserveExplicitAgentDescriptor,
  replaceDescriptorCurrentValue,
} from "./modelTraits.ts";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";

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
});

describe("preserveExplicitAgentDescriptor", () => {
  const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
    },
    { id: "thinking", label: "Thinking", type: "boolean", currentValue: false },
  ];
  const saved: ReadonlyArray<ProviderOptionSelection> = [
    { id: "reasoningEffort", value: "low" },
    { id: "agent", value: "reviewer" },
    { id: "thinking", value: false },
  ];

  it("retains the saved agent through select, boolean, and deliberate agent edits", () => {
    const editingDescriptors = preserveExplicitAgentDescriptor({
      descriptors,
      selections: saved,
      preserve: true,
    });
    const reasoning = editingDescriptors.find(
      (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
        descriptor.id === "reasoningEffort" && descriptor.type === "select",
    );
    if (!reasoning) throw new Error("reasoning descriptor missing");
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(editingDescriptors, ""), descriptors: editingDescriptors },
        reasoning,
        "",
        "high",
      )?.modelOptions,
    ).toContainEqual({ id: "agent", value: "reviewer" });
    expect(
      buildProviderOptionSelectionsFromDescriptors(
        replaceDescriptorCurrentValue(editingDescriptors, "thinking", true),
      ),
    ).toContainEqual({ id: "agent", value: "reviewer" });
    const agent = editingDescriptors.find(
      (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
        descriptor.id === "agent" && descriptor.type === "select",
    );
    if (!agent) throw new Error("agent descriptor missing");
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(editingDescriptors, ""), descriptors: editingDescriptors },
        agent,
        "",
        "build",
      )?.modelOptions,
    ).toContainEqual({ id: "agent", value: "build" });
  });

  it("keeps machine agent choices when no explicit agent is saved and filters plan choices", () => {
    expect(
      preserveExplicitAgentDescriptor({ descriptors, selections: [], preserve: true }),
    ).toEqual(descriptors);
    const filtered = preserveExplicitAgentDescriptor({
      descriptors,
      selections: [{ id: "agent", value: "plan" }],
      preserve: true,
      includePlanAgent: false,
    });
    const agent = filtered.find(
      (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
        descriptor.id === "agent" && descriptor.type === "select",
    );
    expect(agent?.options.map((option) => option.id)).toEqual(["build"]);
    expect(agent?.currentValue).toBe("build");
  });
});
