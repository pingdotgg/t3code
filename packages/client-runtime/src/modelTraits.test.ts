import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

function effort(currentValue: string): ProviderOptionDescriptor {
  return {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    currentValue,
    options: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "custom", label: "Deep Think" },
      { id: "prototype", label: "__proto__" },
    ],
  };
}

function fastMode(currentValue: boolean): ProviderOptionDescriptor {
  return { id: "fastMode", label: "Fast mode", type: "boolean", currentValue };
}

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: ProviderDriverKind.make("claudeAgent"),
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("abbreviates the selected effort", () => {
    expect(display([effort("medium")]).compactEffortLabel).toBe("M");
    expect(display([effort("high")]).compactEffortLabel).toBe("H");
    expect(display([effort("xhigh")]).compactEffortLabel).toBe("XH");
  });

  it("keeps an unknown effort label whole rather than inventing an abbreviation", () => {
    expect(display([effort("custom")]).compactEffortLabel).toBe("Deep Think");
    expect(display([effort("prototype")]).compactEffortLabel).toBe("__proto__");
  });

  it("reports Fast only while it is enabled and keeps the effort when it is off", () => {
    expect(display([effort("high"), fastMode(true)])).toEqual({
      label: "High Fast",
      compactEffortLabel: "H",
      speedLabel: "Fast",
    });
    expect(display([effort("high"), fastMode(false)])).toEqual({
      label: "High",
      compactEffortLabel: "H",
      speedLabel: null,
    });
  });
});
