import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

describe("composer thinking summary", () => {
  it.each([
    { thinking: true, toggleFirst: false, effort: "effort", label: "Extra High · 1M" },
    { thinking: true, toggleFirst: true, effort: "effort", label: "Extra High · 1M" },
    { thinking: false, toggleFirst: false, effort: "effort", label: "Off · 1M" },
    { thinking: false, toggleFirst: true, effort: "effort", label: "Off · 1M" },
    { thinking: true, toggleFirst: true, effort: "thought_level", label: "Extra High · 1M" },
    { thinking: false, toggleFirst: false, effort: "thought_level", label: "Off · 1M" },
    { thinking: true, toggleFirst: true, effort: null, label: "Thinking · 1M" },
    { thinking: false, toggleFirst: true, effort: null, label: "Off · 1M" },
  ])("shows $label with thinking=$thinking and toggleFirst=$toggleFirst", (testCase) => {
    const thinking: ProviderOptionDescriptor = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: testCase.thinking,
    };
    const effort: ProviderOptionDescriptor = {
      id: testCase.effort ?? "effort",
      label: "Reasoning",
      type: "select",
      ...(testCase.effort === "thought_level" ? { role: "reasoning" as const } : {}),
      currentValue: "xhigh",
      options: [{ id: "xhigh", label: "Extra High" }],
    };
    const descriptors: Array<ProviderOptionDescriptor> = [
      ...(testCase.effort
        ? testCase.toggleFirst
          ? [thinking, effort]
          : [effort, thinking]
        : [thinking]),
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        currentValue: "1m",
        options: [{ id: "1m", label: "1M" }],
      },
    ];
    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("claudeAgent"),
        descriptors,
        primarySelectDescriptorId: testCase.effort ?? "contextWindow",
        ultrathinkPromptControlled: false,
      }),
    ).toMatchObject({
      label: testCase.label,
      thinkingOff: !testCase.thinking,
    });
  });
});
