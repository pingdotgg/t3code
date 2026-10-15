import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceId,
  type ModelCapabilities,
  type ModelSelection,
} from "@t3tools/contracts";

import {
  applyProviderOptionSelection,
  composerModelOptionSummary,
  resolveProviderOptionDescriptors,
} from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});

describe("composer model option summary", () => {
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("test-provider"),
    model: "custom-model-with-a-long-name",
  };
  function summary(
    capabilities: ModelCapabilities | null = CODEX_CAPABILITIES,
    selected = selection,
    reported?: ModelSelection,
    provider = "codex",
  ) {
    return composerModelOptionSummary({
      provider,
      descriptors: resolveProviderOptionDescriptors({
        capabilities,
        selections: selected.options,
      }),
      selection: selected,
      reportedSelection: reported,
    });
  }

  it("shows the effective default reasoning and hides standard speed", () => {
    expect(summary()).toEqual({ reasoningLabel: "Medium", speedLabel: undefined });
  });

  const openCodeCapabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "medium",
      },
    ],
  };

  it("omits an unselected OpenCode variant even when the catalog has a default", () => {
    const reported: ModelSelection = {
      ...selection,
      options: [{ id: "variant", value: "high" }],
    };
    for (const report of [
      undefined,
      { ...reported, model: "other-model" },
      { ...reported, instanceId: ProviderInstanceId.make("other-provider") },
    ]) {
      expect(summary(openCodeCapabilities, selection, report, "opencode")).toEqual({
        reasoningLabel: undefined,
        speedLabel: undefined,
      });
    }
  });

  it("preserves explicit and matching reported OpenCode variant labels", () => {
    const reported: ModelSelection = {
      ...selection,
      options: [{ id: "variant", value: "low" }],
    };
    expect(summary(openCodeCapabilities, selection, reported, "opencode").reasoningLabel).toBe(
      "Low",
    );
    expect(
      summary(
        openCodeCapabilities,
        { ...selection, options: [{ id: "variant", value: "high" }] },
        reported,
        "opencode",
      ).reasoningLabel,
    ).toBe("High");
    expect(
      summary(
        openCodeCapabilities,
        selection,
        { ...selection, options: [{ id: "variant", value: "default" }] },
        "opencode",
      ).reasoningLabel,
    ).toBe("Default");
  });

  it("shows a selected reasoning label and Codex fast tier", () => {
    expect(
      summary(CODEX_CAPABILITIES, {
        ...selection,
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      }),
    ).toEqual({ reasoningLabel: "High", speedLabel: "Fast" });
  });

  it.each(["reasoningEffort", "reasoning", "effort", "variant", "thinking"])(
    "uses advertised reasoning labels for %s",
    (id) => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          {
            id,
            label: "Reasoning",
            type: "select",
            options: [{ id: "xhigh", label: "Extra High", isDefault: true }],
          },
        ],
      };
      const selected = { ...selection, options: [{ id, value: "xhigh" }] };
      expect(summary(capabilities, selected)).toEqual({
        reasoningLabel: "Extra High",
        speedLabel: undefined,
      });
    },
  );

  it.each(["claudeAgent", "cursor", "opencode"])(
    "shows and clears boolean fast mode for %s",
    (provider) => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      };
      for (const value of [true, false]) {
        expect(
          summary(
            capabilities,
            { ...selection, options: [{ id: "fastMode", value }] },
            undefined,
            provider,
          ),
        ).toEqual({ reasoningLabel: undefined, speedLabel: value ? "Fast" : undefined });
      }
    },
  );

  it("uses matching provider-reported options when no explicit override exists", () => {
    const reported: ModelSelection = {
      ...selection,
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    };
    expect(summary(CODEX_CAPABILITIES, selection, reported)).toEqual({
      reasoningLabel: "High",
      speedLabel: "Fast",
    });
    expect(
      summary(
        CODEX_CAPABILITIES,
        {
          ...selection,
          options: [
            { id: "reasoningEffort", value: "medium" },
            { id: "serviceTier", value: "default" },
          ],
        },
        reported,
      ),
    ).toEqual({ reasoningLabel: "Medium", speedLabel: undefined });
    for (const other of [
      { ...reported, model: "other-model" },
      { ...reported, instanceId: ProviderInstanceId.make("other-provider") },
    ]) {
      expect(summary(CODEX_CAPABILITIES, selection, other)).toEqual({
        reasoningLabel: "Medium",
        speedLabel: undefined,
      });
    }
  });

  it("does not turn unsupported or unrelated options into indicators", () => {
    const selected: ModelSelection = {
      ...selection,
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    };
    expect(summary(null, selected)).toEqual({ reasoningLabel: undefined, speedLabel: undefined });
    expect(summary({ optionDescriptors: [] }, selected)).toEqual({
      reasoningLabel: undefined,
      speedLabel: undefined,
    });
    expect(
      summary({
        optionDescriptors: [
          {
            id: "contextWindow",
            label: "Context Window",
            type: "select",
            options: [{ id: "expanded", label: "Expanded", isDefault: true }],
          },
        ],
      }),
    ).toEqual({ reasoningLabel: undefined, speedLabel: undefined });
  });

  it("recognizes only advertised Codex fast and ultrafast tiers", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "priority", label: "Fast" },
            { id: "ultrafast", label: "Ultrafast" },
            { id: "flex", label: "Flex" },
          ],
        },
      ],
    };
    for (const [value, expected] of [
      ["default", undefined],
      ["priority", "Fast"],
      ["ultrafast", "Ultrafast"],
      ["flex", undefined],
      ["unknown", undefined],
    ] as const) {
      const selected = { ...selection, options: [{ id: "serviceTier", value }] };
      expect(summary(capabilities, selected).speedLabel).toBe(expected);
      expect(summary(capabilities, selected, undefined, "cursor").speedLabel).toBeUndefined();
    }
  });

  it("shows boolean thinking independently of speed", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
    };
    for (const value of [true, false]) {
      expect(summary(capabilities, { ...selection, options: [{ id: "thinking", value }] })).toEqual(
        { reasoningLabel: value ? "Thinking" : "No thinking", speedLabel: undefined },
      );
    }
  });
});
