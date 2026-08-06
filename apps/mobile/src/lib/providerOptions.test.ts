import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  LOCKED_PROVIDER_OPTION_ALERT,
  providerOptionsConfigurationLabel,
  resolveProviderOptionDescriptors,
  resolveProviderOptionMenuChange,
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

const BOOLEAN_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
};

function optionEventId(
  descriptors: ReturnType<typeof resolveProviderOptionDescriptors>,
  groupIndex: number,
  choiceIndex: number,
): string {
  const id = buildProviderOptionMenuActions(descriptors)[groupIndex]?.subactions?.[choiceIndex]?.id;
  expect(id).toBeDefined();
  return id!;
}

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
      capabilities: BOOLEAN_CAPABILITIES,
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

  it("does not mark provider option choices as disabled", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    for (const action of buildProviderOptionMenuActions(descriptors)) {
      for (const choice of action.subactions ?? []) {
        expect(choice.attributes).toBeUndefined();
      }
    }
  });
});

describe("resolveProviderOptionMenuChange", () => {
  it("ignores re-selecting the current select value without an update payload", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });
    const currentEvent = optionEventId(descriptors, 0, 0);

    expect(
      resolveProviderOptionMenuChange(descriptors, currentEvent, { optionsLocked: true }),
    ).toEqual({ action: "ignore" });
  });

  it("ignores re-selecting the current boolean value without an update payload", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: BOOLEAN_CAPABILITIES,
      selections: undefined,
    });
    const currentOffEvent = optionEventId(descriptors, 0, 0);

    expect(resolveProviderOptionMenuChange(descriptors, currentOffEvent)).toEqual({
      action: "ignore",
    });
  });

  it("warns for a locked select change with no update payload", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });
    const highEvent = optionEventId(descriptors, 0, 1);

    expect(
      resolveProviderOptionMenuChange(descriptors, highEvent, { optionsLocked: true }),
    ).toEqual({
      action: "warn",
      title: LOCKED_PROVIDER_OPTION_ALERT.title,
      description: LOCKED_PROVIDER_OPTION_ALERT.description,
    });
  });

  it("warns for a locked boolean change with no update payload", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: BOOLEAN_CAPABILITIES,
      selections: undefined,
    });
    const onEvent = optionEventId(descriptors, 0, 1);

    expect(resolveProviderOptionMenuChange(descriptors, onEvent, { optionsLocked: true })).toEqual({
      action: "warn",
      title: LOCKED_PROVIDER_OPTION_ALERT.title,
      description: LOCKED_PROVIDER_OPTION_ALERT.description,
    });
  });

  it("returns an update payload for an unlocked select change", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });
    const highEvent = optionEventId(descriptors, 0, 1);

    expect(resolveProviderOptionMenuChange(descriptors, highEvent)).toEqual({
      action: "apply",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ],
    });
  });

  it("returns an update payload for an unlocked boolean change", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: BOOLEAN_CAPABILITIES,
      selections: undefined,
    });
    const onEvent = optionEventId(descriptors, 0, 1);

    expect(resolveProviderOptionMenuChange(descriptors, onEvent)).toEqual({
      action: "apply",
      options: [{ id: "fastMode", value: true }],
    });
  });
});
