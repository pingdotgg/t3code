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
