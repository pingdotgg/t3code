import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  providerOptionsConfigurationLabel,
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
  it("renders the option descriptors advertised by the selected model", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(buildProviderOptionMenuActions(descriptors)).toMatchObject([
      {
        title: "Reasoning",
        subtitle: "Medium",
        subactions: [
          { title: "Auto", state: undefined },
          { title: "Medium (default)", state: "on" },
          { title: "High", state: undefined },
        ],
      },
      {
        title: "Service Tier",
        subtitle: "Standard",
        subactions: [
          { title: "Standard (default)", state: "on" },
          { title: "Fast", state: undefined },
        ],
      },
    ]);
    expect(providerOptionsConfigurationLabel(descriptors)).toBe("Medium · Standard");
  });

  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });
    const actions = buildProviderOptionMenuActions(descriptors);
    const fastEvent = actions[1]?.subactions?.[1]?.id;

    expect(fastEvent).toBeDefined();
    expect(applyProviderOptionMenuEvent(descriptors, fastEvent!)).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
  });

  it("reveals the auto effort limits only once auto is selected", () => {
    const manual = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(buildProviderOptionMenuActions(manual).map((action) => action.title)).toEqual([
      "Reasoning",
      "Service Tier",
    ]);

    const auto = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: [{ id: "reasoningEffort", value: "auto" }],
    });
    expect(buildProviderOptionMenuActions(auto).map((action) => action.title)).toEqual([
      "Reasoning",
      "Minimum",
      "Maximum",
      "Service Tier",
    ]);
    expect(providerOptionsConfigurationLabel(auto)).toBe("Auto · Standard");
  });

  it("keeps the auto limits from contradicting each other", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: [
        { id: "reasoningEffort", value: "auto" },
        { id: "reasoningEffortAutoCeiling", value: "medium" },
        { id: "reasoningEffortAutoFloor", value: "medium" },
      ],
    });
    const minimumHigh = buildProviderOptionMenuActions(descriptors)
      .find((action) => action.title === "Minimum")
      ?.subactions?.find((subaction) => subaction.title === "High");

    expect(minimumHigh?.id).toBeDefined();
    expect(applyProviderOptionMenuEvent(descriptors, minimumHigh!.id!)).toEqual([
      { id: "reasoningEffort", value: "auto" },
      { id: "reasoningEffortAutoFloor", value: "high" },
      { id: "reasoningEffortAutoCeiling", value: "high" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("keeps stored auto limits out of the menu after switching back to a manual effort", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "reasoningEffortAutoCeiling", value: "high" },
      ],
    });

    expect(buildProviderOptionMenuActions(descriptors).map((action) => action.title)).toEqual([
      "Reasoning",
      "Service Tier",
    ]);
    // The stored limit still round-trips so re-enabling Auto keeps the choice.
    expect(applyProviderOptionMenuEvent(descriptors, "provider-option:bogus")).toBeNull();
    expect(providerOptionsConfigurationLabel(descriptors)).toBe("High · Standard");
  });

  it("treats an unspecified boolean capability as off", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(buildProviderOptionMenuActions(descriptors)).toMatchObject([
      {
        title: "Fast Mode",
        subtitle: "Off",
        subactions: [
          { title: "Off", state: "on" },
          { title: "On", state: undefined },
        ],
      },
    ]);
    expect(providerOptionsConfigurationLabel(descriptors)).toBe("Configuration");
  });
});
