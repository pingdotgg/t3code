import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

describe("composer thinking summary", () => {
  it.each([
    { thinking: true, toggleFirst: false, label: "Extra High · 1M" },
    { thinking: true, toggleFirst: true, label: "Extra High · 1M" },
    { thinking: false, toggleFirst: false, label: "Off · 1M" },
    { thinking: false, toggleFirst: true, label: "Off · 1M" },
  ])("shows $label with thinking=$thinking and toggleFirst=$toggleFirst", (testCase) => {
    const thinking: ProviderOptionDescriptor = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: testCase.thinking,
    };
    const effort: ProviderOptionDescriptor = {
      id: "effort",
      label: "Reasoning",
      type: "select",
      currentValue: "xhigh",
      options: [{ id: "xhigh", label: "Extra High" }],
    };
    const descriptors: Array<ProviderOptionDescriptor> = [
      ...(testCase.toggleFirst ? [thinking, effort] : [effort, thinking]),
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
        primarySelectDescriptorId: "effort",
        ultrathinkPromptControlled: false,
      }),
    ).toMatchObject({
      label: testCase.label,
      otherLabels: ["1M"],
      thinkingOff: !testCase.thinking,
    });
  });
});
