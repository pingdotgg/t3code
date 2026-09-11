import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  getReasoningLevelDescriptor,
  resolveReasoningLevel,
  resolveReasoningLevelLabel,
  withReasoningLevelChange,
  getModelFamilyLabel,
  getProviderGroupLabel,
  groupByProvider,
  findModelCapabilities,
} from "./modelFamilyGrouping";

function capsWithEffort(
  effortId: string,
  options: Array<{ id: string; label: string; isDefault?: boolean }>,
  currentValue?: string,
): ModelCapabilities {
  return {
    optionDescriptors: [
      {
        id: effortId,
        label: "Reasoning effort",
        type: "select",
        options,
        ...(currentValue ? { currentValue } : {}),
      },
    ],
  };
}

describe("getReasoningLevelDescriptor", () => {
  it("extracts the effort select descriptor by id", () => {
    const caps = capsWithEffort("effort", [
      { id: "low", label: "Low", isDefault: true },
      { id: "high", label: "High" },
    ]);
    const descriptor = getReasoningLevelDescriptor({
      caps,
      selections: [{ id: "effort", value: "high" }],
    });
    expect(descriptor).not.toBeNull();
    expect(descriptor!.descriptorId).toBe("effort");
    expect(descriptor!.currentValue).toBe("high");
    expect(descriptor!.options).toHaveLength(2);
  });

  it("falls back to the first select descriptor when no id matches", () => {
    const caps: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "serviceTier",
          label: "Service tier",
          type: "select",
          options: [{ id: "default", label: "Default", isDefault: true }],
        },
      ],
    };
    const descriptor = getReasoningLevelDescriptor({ caps });
    expect(descriptor).not.toBeNull();
    expect(descriptor!.descriptorId).toBe("serviceTier");
  });

  it("returns null when there are no select descriptors", () => {
    const caps: ModelCapabilities = {
      optionDescriptors: [
        { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: false },
      ],
    };
    expect(getReasoningLevelDescriptor({ caps })).toBeNull();
  });

  it("resolves the default value when no selection is stored", () => {
    const caps = capsWithEffort("effort", [
      { id: "low", label: "Low", isDefault: true },
      { id: "high", label: "High" },
    ]);
    const descriptor = getReasoningLevelDescriptor({ caps, selections: null });
    expect(descriptor!.currentValue).toBe("low");
  });
});

describe("resolveReasoningLevel", () => {
  it("returns the stored effort value", () => {
    const caps = capsWithEffort("effort", [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    expect(resolveReasoningLevel({ caps, selections: [{ id: "effort", value: "high" }] })).toBe(
      "high",
    );
  });

  it("returns null when the model has no reasoning descriptor", () => {
    const caps: ModelCapabilities = { optionDescriptors: [] };
    expect(resolveReasoningLevel({ caps })).toBeNull();
  });
});

describe("resolveReasoningLevelLabel", () => {
  it("returns the human-readable label for the current value", () => {
    const caps = capsWithEffort("effort", [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    expect(
      resolveReasoningLevelLabel({ caps, selections: [{ id: "effort", value: "high" }] }),
    ).toBe("High");
  });

  it("returns null when no reasoning descriptor exists", () => {
    const caps: ModelCapabilities = { optionDescriptors: [] };
    expect(resolveReasoningLevelLabel({ caps })).toBeNull();
  });
});

describe("withReasoningLevelChange", () => {
  it("replaces the reasoning value and preserves other options", () => {
    const caps = capsWithEffort("effort", [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    const selections: ProviderOptionSelection[] = [
      { id: "effort", value: "low" },
      { id: "fastMode", value: true },
    ];
    const next = withReasoningLevelChange({ caps, selections, nextValue: "high" });
    expect(next).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "high" },
    ]);
  });

  it("adds the reasoning option when no prior selection exists", () => {
    const caps = capsWithEffort("effort", [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ]);
    const next = withReasoningLevelChange({ caps, selections: [], nextValue: "high" });
    expect(next).toEqual([{ id: "effort", value: "high" }]);
  });

  it("returns undefined when the model has no reasoning descriptor", () => {
    const caps: ModelCapabilities = { optionDescriptors: [] };
    expect(withReasoningLevelChange({ caps, selections: [], nextValue: "high" })).toBeUndefined();
  });
});

describe("getModelFamilyLabel", () => {
  it("strips trailing reasoning qualifiers from the slug", () => {
    expect(
      getModelFamilyLabel("claude-sonnet-5-high", ProviderDriverKind.make("claudeAgent")),
    ).toBe("Claude Sonnet 5");
  });

  it("uses the fallback name when the slug has no qualifier", () => {
    expect(
      getModelFamilyLabel(
        "claude-sonnet-5",
        ProviderDriverKind.make("claudeAgent"),
        "Claude Sonnet 5",
      ),
    ).toBe("Claude Sonnet 5");
  });

  it("humanizes a bare slug", () => {
    expect(getModelFamilyLabel("gpt-5-codex", ProviderDriverKind.make("codex"))).toBe(
      "Gpt 5 Codex",
    );
  });
});

describe("getProviderGroupLabel", () => {
  it("uses the canonical PROVIDER_DISPLAY_NAMES entry", () => {
    expect(getProviderGroupLabel(ProviderDriverKind.make("claudeAgent"))).toBe("Claude");
    expect(getProviderGroupLabel(ProviderDriverKind.make("devin"))).toBe("Devin");
  });

  it("falls back to a humanized slug for unknown kinds", () => {
    expect(getProviderGroupLabel(ProviderDriverKind.make("claudeAgent"))).not.toBe("claudeAgent");
  });
});

describe("groupByProvider", () => {
  const codex = ProviderDriverKind.make("codex");
  const claude = ProviderDriverKind.make("claudeAgent");
  const grok = ProviderDriverKind.make("grok");

  it("groups items by driver kind preserving first-appearance order", () => {
    const items = [
      { driverKind: codex, slug: "gpt-5" },
      { driverKind: claude, slug: "sonnet" },
      { driverKind: codex, slug: "gpt-5.4" },
      { driverKind: grok, slug: "grok-build" },
    ];
    const groups = groupByProvider(items);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.driverKind).toBe("codex");
    expect(groups[0]!.items.map((i) => i.slug)).toEqual(["gpt-5", "gpt-5.4"]);
    expect(groups[1]!.driverKind).toBe("claudeAgent");
    expect(groups[1]!.items).toHaveLength(1);
    expect(groups[2]!.driverKind).toBe("grok");
  });

  it("returns a single group when all items share a provider", () => {
    const items = [
      { driverKind: codex, slug: "a" },
      { driverKind: codex, slug: "b" },
    ];
    const groups = groupByProvider(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("returns an empty array for no items", () => {
    expect(groupByProvider([])).toEqual([]);
  });
});

describe("findModelCapabilities", () => {
  it("returns the matching model capabilities", () => {
    const caps = capsWithEffort("effort", [{ id: "low", label: "Low" }]);
    const models = [
      { slug: "model-a", name: "Model A", isCustom: false, capabilities: caps },
      {
        slug: "model-b",
        name: "Model B",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ];
    expect(findModelCapabilities(models, "model-a")).toBe(caps);
  });

  it("returns empty capabilities when the model is not found", () => {
    const result = findModelCapabilities([], "missing");
    expect(result.optionDescriptors).toEqual([]);
  });
});
