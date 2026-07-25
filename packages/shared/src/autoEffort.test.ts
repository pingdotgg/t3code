import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  AUTO_EFFORT_VALUE,
  autoEffortAllowedChoices,
  autoEffortCeilingOptionId,
  autoEffortFloorOptionId,
  autoEffortManualDefault,
  clampAutoEffort,
  getAutoEffortAwareDescriptors,
  isAutoEffortActive,
  reconcileAutoEffortLimitDescriptors,
  resolveAutoEffortBounds,
  resolveAutoEffortSelection,
  resolveAutoEffortState,
  withoutAutoEffortValue,
} from "./autoEffort.ts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
} from "./model.ts";

/** Codex-shaped capabilities, deliberately declared out of cheapest-first order. */
const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "medium", label: "Medium" },
      ],
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [{ id: "default", label: "Standard", isDefault: true }],
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "max", label: "Max" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      promptInjectedValues: ["ultrathink"],
    },
  ],
});

const singleEffortCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "high", label: "High", isDefault: true }],
    },
  ],
});

const autoSelection = (options: ReadonlyArray<{ id: string; value: string }>) =>
  createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol", options);

describe("auto effort state", () => {
  it("orders the ladder cheapest first regardless of provider declaration order", () => {
    const state = resolveAutoEffortState({ caps: codexCaps });

    expect(state?.ladder.map((option) => option.id)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("excludes prompt-injected efforts from the ladder", () => {
    const state = resolveAutoEffortState({ caps: claudeCaps });

    expect(state?.ladder.map((option) => option.id)).toEqual(["low", "high", "max"]);
  });

  it("defaults the ceiling to the model default so enabling auto cannot spend more", () => {
    const state = resolveAutoEffortState({ caps: codexCaps });

    expect(state?.ceiling).toBe("high");
    expect(state?.floor).toBe("low");
    expect(state?.fallback).toBe("high");
  });

  it("reads stored ceiling and floor selections", () => {
    const bounds = resolveAutoEffortBounds({
      descriptor: {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
      },
      selections: [
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "xhigh" },
        { id: autoEffortFloorOptionId("reasoningEffort"), value: "medium" },
      ],
    });

    expect(bounds).toEqual({ ceiling: "xhigh", floor: "medium" });
  });

  it("treats an inverted range as unordered instead of failing", () => {
    const bounds = resolveAutoEffortBounds({
      descriptor: {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
      selections: [
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "low" },
        { id: autoEffortFloorOptionId("reasoningEffort"), value: "high" },
      ],
    });

    expect(bounds).toEqual({ ceiling: "high", floor: "low" });
  });

  it("declines auto for models with a single effort rung", () => {
    expect(resolveAutoEffortState({ caps: singleEffortCaps })).toBeNull();
  });

  it("declines auto for models without an effort select", () => {
    expect(
      resolveAutoEffortState({
        caps: createModelCapabilities({
          optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
        }),
      }),
    ).toBeNull();
  });

  it("lands on the provider default when auto is switched off", () => {
    const codexEffort = codexCaps.optionDescriptors?.[0];
    expect(codexEffort?.type === "select" ? autoEffortManualDefault(codexEffort) : undefined).toBe(
      "high",
    );
  });

  it("reports auto as active only when the effort selection is auto", () => {
    expect(
      isAutoEffortActive({
        caps: codexCaps,
        selections: [{ id: "reasoningEffort", value: AUTO_EFFORT_VALUE }],
      }),
    ).toBe(true);
    expect(
      isAutoEffortActive({
        caps: codexCaps,
        selections: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toBe(false);
  });
});

describe("clamping", () => {
  const state = resolveAutoEffortState({
    caps: codexCaps,
    selections: [
      { id: autoEffortCeilingOptionId("reasoningEffort"), value: "high" },
      { id: autoEffortFloorOptionId("reasoningEffort"), value: "medium" },
    ],
  });

  it("keeps values inside the window", () => {
    expect(clampAutoEffort(state!, "high")).toBe("high");
    expect(clampAutoEffort(state!, "medium")).toBe("medium");
  });

  it("caps values above the ceiling", () => {
    expect(clampAutoEffort(state!, "xhigh")).toBe("high");
  });

  it("raises values below the floor", () => {
    expect(clampAutoEffort(state!, "low")).toBe("medium");
  });

  it("falls back to the ceiling for unknown values", () => {
    expect(clampAutoEffort(state!, "turbo")).toBe("high");
    expect(clampAutoEffort(state!, null)).toBe("high");
  });

  it("offers only the efforts inside the window", () => {
    expect(autoEffortAllowedChoices(state!).map((option) => option.id)).toEqual(["medium", "high"]);
  });

  it("collapses to a single choice when the window is one rung wide", () => {
    const pinned = resolveAutoEffortState({
      caps: codexCaps,
      selections: [
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "low" },
        { id: autoEffortFloorOptionId("reasoningEffort"), value: "low" },
      ],
    });

    expect(autoEffortAllowedChoices(pinned!).map((option) => option.id)).toEqual(["low"]);
  });
});

describe("auto-effort-aware descriptors", () => {
  it("offers auto without adding limit selects until auto is used", () => {
    const descriptors = getAutoEffortAwareDescriptors({ caps: codexCaps });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
      "serviceTier",
    ]);
    const effort = descriptors[0];
    expect(effort?.type === "select" && effort.options[0]?.id).toBe(AUTO_EFFORT_VALUE);
  });

  it("adds the auto limits once auto is selected", () => {
    const descriptors = getAutoEffortAwareDescriptors({
      caps: codexCaps,
      selections: [{ id: "reasoningEffort", value: AUTO_EFFORT_VALUE }],
    });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
      autoEffortFloorOptionId("reasoningEffort"),
      autoEffortCeilingOptionId("reasoningEffort"),
      "serviceTier",
    ]);
    expect(
      descriptors
        .filter((descriptor) => descriptor.id.startsWith("reasoningEffortAuto"))
        .map((descriptor) => descriptor.label),
    ).toEqual(["Minimum", "Maximum"]);
  });

  it("keeps configured limits after switching back to a manual effort", () => {
    const descriptors = getAutoEffortAwareDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "xhigh" },
      ],
    });

    expect(
      descriptors.find(
        (descriptor) => descriptor.id === autoEffortCeilingOptionId("reasoningEffort"),
      )?.currentValue,
    ).toBe("xhigh");
  });

  it("keeps a stored auto selection instead of falling back to the provider default", () => {
    const descriptors = getAutoEffortAwareDescriptors({
      caps: codexCaps,
      selections: [{ id: "reasoningEffort", value: AUTO_EFFORT_VALUE }],
    });

    expect(descriptors[0]?.currentValue).toBe(AUTO_EFFORT_VALUE);
  });

  it("round-trips auto and its bounds through selection persistence", () => {
    const descriptors = getAutoEffortAwareDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: AUTO_EFFORT_VALUE },
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "xhigh" },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: AUTO_EFFORT_VALUE },
      { id: autoEffortFloorOptionId("reasoningEffort"), value: "low" },
      { id: autoEffortCeilingOptionId("reasoningEffort"), value: "xhigh" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("leaves capabilities without an effort select untouched", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });

    expect(getAutoEffortAwareDescriptors({ caps }).map((descriptor) => descriptor.id)).toEqual([
      "fastMode",
    ]);
  });
});

describe("limit reconciliation", () => {
  const limitDescriptors = (ceiling: string, floor: string) =>
    getAutoEffortAwareDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: AUTO_EFFORT_VALUE },
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: ceiling },
        { id: autoEffortFloorOptionId("reasoningEffort"), value: floor },
      ],
    });

  const valuesAfterChange = (input: {
    ceiling: string;
    floor: string;
    changedId: string;
  }): { ceiling: unknown; floor: unknown } => {
    const reconciled = reconcileAutoEffortLimitDescriptors(
      limitDescriptors(input.ceiling, input.floor),
      input.changedId,
    );
    const find = (id: string) => reconciled.find((descriptor) => descriptor.id === id);
    return {
      ceiling: find(autoEffortCeilingOptionId("reasoningEffort"))?.currentValue,
      floor: find(autoEffortFloorOptionId("reasoningEffort"))?.currentValue,
    };
  };

  it("drags the maximum up when the minimum is raised past it", () => {
    expect(
      valuesAfterChange({
        ceiling: "high",
        floor: "xhigh",
        changedId: autoEffortFloorOptionId("reasoningEffort"),
      }),
    ).toEqual({ ceiling: "xhigh", floor: "xhigh" });
  });

  it("drags the minimum down when the maximum is lowered past it", () => {
    expect(
      valuesAfterChange({
        ceiling: "low",
        floor: "high",
        changedId: autoEffortCeilingOptionId("reasoningEffort"),
      }),
    ).toEqual({ ceiling: "low", floor: "low" });
  });

  it("leaves a consistent window alone", () => {
    expect(
      valuesAfterChange({
        ceiling: "high",
        floor: "low",
        changedId: autoEffortFloorOptionId("reasoningEffort"),
      }),
    ).toEqual({ ceiling: "high", floor: "low" });
  });

  it("ignores changes to descriptors that are not limits", () => {
    const descriptors = limitDescriptors("high", "xhigh");

    expect(reconcileAutoEffortLimitDescriptors(descriptors, "serviceTier")).toBe(descriptors);
  });
});

describe("resolving a selection for a turn", () => {
  it("replaces auto with the reviewer's choice", () => {
    const resolved = resolveAutoEffortSelection({
      modelSelection: autoSelection([
        { id: "reasoningEffort", value: AUTO_EFFORT_VALUE },
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "xhigh" },
        { id: "serviceTier", value: "default" },
      ]),
      caps: codexCaps,
      requestedEffort: "medium",
    });

    expect(resolved?.effort).toBe("medium");
    expect(resolved?.clamped).toBe(false);
    expect(resolved?.modelSelection.options).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: autoEffortCeilingOptionId("reasoningEffort"), value: "xhigh" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("clamps a reviewer choice above the ceiling and reports it", () => {
    const resolved = resolveAutoEffortSelection({
      modelSelection: autoSelection([
        { id: "reasoningEffort", value: AUTO_EFFORT_VALUE },
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "high" },
      ]),
      caps: codexCaps,
      requestedEffort: "xhigh",
    });

    expect(resolved?.effort).toBe("high");
    expect(resolved?.requested).toBe("xhigh");
    expect(resolved?.clamped).toBe(true);
  });

  it("uses the clamped default when no reviewer choice is available", () => {
    const resolved = resolveAutoEffortSelection({
      modelSelection: autoSelection([
        { id: "reasoningEffort", value: AUTO_EFFORT_VALUE },
        { id: autoEffortFloorOptionId("reasoningEffort"), value: "xhigh" },
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "xhigh" },
      ]),
      caps: codexCaps,
      requestedEffort: null,
    });

    expect(resolved?.effort).toBe("xhigh");
    expect(resolved?.requested).toBeNull();
  });

  it("falls back to the provider default, clamped to the window, without a reviewer", () => {
    const resolved = resolveAutoEffortSelection({
      modelSelection: autoSelection([
        { id: "reasoningEffort", value: AUTO_EFFORT_VALUE },
        { id: autoEffortCeilingOptionId("reasoningEffort"), value: "medium" },
      ]),
      caps: codexCaps,
      requestedEffort: null,
    });

    // codexCaps defaults to high, which the medium ceiling caps.
    expect(resolved?.effort).toBe("medium");
  });

  it("passes through selections that are not on auto", () => {
    expect(
      resolveAutoEffortSelection({
        modelSelection: autoSelection([{ id: "reasoningEffort", value: "high" }]),
        caps: codexCaps,
        requestedEffort: "low",
      }),
    ).toBeNull();
  });
});

describe("auto value guard", () => {
  it("hides auto from provider-bound effort reads", () => {
    expect(withoutAutoEffortValue(AUTO_EFFORT_VALUE)).toBeUndefined();
    expect(withoutAutoEffortValue("high")).toBe("high");
    expect(withoutAutoEffortValue(undefined)).toBeUndefined();
  });
});
