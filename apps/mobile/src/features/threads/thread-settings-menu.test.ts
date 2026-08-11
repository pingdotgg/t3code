import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionDescriptor } from "@t3tools/contracts";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { buildThreadSettingsMenu, type ThreadSettingsMenuEvent } from "./thread-settings-menu";

function modelOption(
  model: string,
  overrides: Partial<Pick<ModelOption, "isDefault" | "isLegacy" | "providerKey">> = {},
): ModelOption {
  const providerKey = overrides.providerKey ?? "codex";
  return {
    key: `${providerKey}:${model}`,
    label: model,
    subtitle: providerKey,
    providerKey,
    providerLabel: providerKey === "codex" ? "Codex" : "Claude",
    providerDriver: providerKey === "codex" ? "codex" : "claudeAgent",
    isDefault: overrides.isDefault ?? false,
    isLegacy: overrides.isLegacy ?? false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make(providerKey),
      model,
      options: [],
    },
  };
}

function group(models: ReadonlyArray<ModelOption>): ProviderGroup {
  const first = models[0];
  if (!first) {
    throw new Error("group requires at least one model");
  }
  return {
    providerKey: first.providerKey,
    providerLabel: first.providerLabel,
    models,
  };
}

const effortDescriptor: ProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

const fastModeDescriptor: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast mode",
  type: "boolean",
  currentValue: false,
};

function baseInput() {
  const models = [
    modelOption("gpt-current", { isDefault: true }),
    modelOption("gpt-next"),
    modelOption("gpt-old", { isLegacy: true }),
  ];
  return {
    providerGroups: [group(models)],
    selectedModel: models[0]?.selection ?? null,
    optionDescriptors: [effortDescriptor, fastModeDescriptor],
    runtimeMode: "auto",
  } as const;
}

function eventFor(menu: ReturnType<typeof buildThreadSettingsMenu>, id: string | undefined) {
  return id === undefined ? undefined : menu.events.get(id);
}

describe("buildThreadSettingsMenu", () => {
  it("orders the top level as model, options, runtime", () => {
    const menu = buildThreadSettingsMenu(baseInput());

    expect(menu.actions.map((action) => action.title)).toEqual([
      "Model",
      "Reasoning",
      "Fast mode",
      "Runtime",
    ]);
  });

  it("summarizes the current choice on each submenu row", () => {
    const menu = buildThreadSettingsMenu(baseInput());

    expect(menu.actions.find((action) => action.title === "Model")?.subtitle).toBe("gpt-current");
    expect(menu.actions.find((action) => action.title === "Reasoning")?.subtitle).toBe("High");
    expect(menu.actions.find((action) => action.title === "Runtime")?.subtitle).toBe("Auto");
  });

  it("checkmarks the selected model and resolves selection events", () => {
    const menu = buildThreadSettingsMenu(baseInput());

    const modelItems = menu.actions.find((action) => action.title === "Model")?.subactions ?? [];
    const current = modelItems.find((action) => action.title === "gpt-current");
    expect(current?.state).toBe("on");
    expect(current?.subtitle).toBe("Default");
    expect(modelItems.find((action) => action.title === "gpt-next")?.state).toBe("off");

    const event = eventFor(menu, modelItems.find((action) => action.title === "gpt-next")?.id);
    expect(event?.type).toBe("select-model");
    expect(event?.type === "select-model" ? event.option.selection.model : null).toBe("gpt-next");
  });

  it("folds unselected legacy models behind a nested submenu", () => {
    const menu = buildThreadSettingsMenu(baseInput());

    const modelItems = menu.actions.find((action) => action.title === "Model")?.subactions ?? [];
    expect(modelItems.map((action) => action.title)).toEqual([
      "gpt-current",
      "gpt-next",
      "Legacy Models",
    ]);
    expect(
      modelItems
        .find((action) => action.title === "Legacy Models")
        ?.subactions?.map((action) => action.title),
    ).toEqual(["gpt-old"]);
  });

  it("keeps a selected legacy model in the main list", () => {
    const input = baseInput();
    const legacy = input.providerGroups[0]?.models.find((model) => model.isLegacy);
    const menu = buildThreadSettingsMenu({
      ...input,
      selectedModel: legacy?.selection ?? null,
    });

    const modelItems = menu.actions.find((action) => action.title === "Model")?.subactions ?? [];
    expect(modelItems.map((action) => action.title)).toEqual([
      "gpt-current",
      "gpt-next",
      "gpt-old",
    ]);
    expect(modelItems.find((action) => action.title === "gpt-old")?.state).toBe("on");
  });

  it("hides prompt-injected and workflow-trigger efforts but still summarizes them", () => {
    const menu = buildThreadSettingsMenu({
      ...baseInput(),
      optionDescriptors: [{ ...effortDescriptor, currentValue: "ultracode" }],
    });

    const reasoning = menu.actions.find((action) => action.title === "Reasoning");
    expect(reasoning?.subactions?.map((action) => action.title)).toEqual(["Low", "Medium", "High"]);
    // The hidden value stays visible as the current summary; it just can't be
    // picked from the phone.
    expect(reasoning?.subtitle).toBe("Ultracode");
    expect(reasoning?.subactions?.every((action) => action.state === "off")).toBe(true);
  });

  it("resolves select-option and runtime events with checkmarked current values", () => {
    const menu = buildThreadSettingsMenu(baseInput());

    const reasoningItems =
      menu.actions.find((action) => action.title === "Reasoning")?.subactions ?? [];
    expect(reasoningItems.find((action) => action.title === "High")?.state).toBe("on");
    expect(eventFor(menu, reasoningItems.find((action) => action.title === "Low")?.id)).toEqual({
      type: "set-option",
      optionId: "effort",
      value: "low",
    });

    const runtimeItems =
      menu.actions.find((action) => action.title === "Runtime")?.subactions ?? [];
    expect(runtimeItems.find((action) => action.title === "Auto")?.state).toBe("on");
    expect(
      eventFor(menu, runtimeItems.find((action) => action.title === "Full access")?.id),
    ).toEqual({ type: "set-runtime", mode: "full-access" });
  });

  it("toggles boolean options with the inverted current value", () => {
    const menu = buildThreadSettingsMenu(baseInput());

    const fastMode = menu.actions.find((action) => action.title === "Fast mode");
    expect(fastMode?.state).toBe("off");
    expect(fastMode?.subactions).toBeUndefined();
    expect(eventFor(menu, fastMode?.id)).toEqual({
      type: "set-option",
      optionId: "fastMode",
      value: true,
    });

    const enabled = buildThreadSettingsMenu({
      ...baseInput(),
      optionDescriptors: [{ ...fastModeDescriptor, currentValue: true }],
    });
    const enabledRow = enabled.actions.find((action) => action.title === "Fast mode");
    expect(enabledRow?.state).toBe("on");
    expect(eventFor(enabled, enabledRow?.id)).toEqual({
      type: "set-option",
      optionId: "fastMode",
      value: false,
    });
  });

  it("keeps the menu presented only for top-level toggles", () => {
    const menu = buildThreadSettingsMenu(baseInput());

    // Root-level boolean toggles refresh in place with clean chrome, so they
    // keep the menu presented.
    expect(
      menu.actions.find((action) => action.title === "Fast mode")?.attributes?.keepsMenuPresented,
    ).toBe(true);

    // Picks inside nested submenus close the menu: staying presented leaves
    // the submenu on screen with an expanded-submenu header, and the
    // bottom-anchored collapse back out drops by the levels' height delta.
    const expected = undefined;
    const modelItems = menu.actions.find((action) => action.title === "Model")?.subactions ?? [];
    const reasoningItems =
      menu.actions.find((action) => action.title === "Reasoning")?.subactions ?? [];
    const runtimeItems =
      menu.actions.find((action) => action.title === "Runtime")?.subactions ?? [];
    const nestedPicks = [...modelItems, ...reasoningItems, ...runtimeItems].filter(
      (action) => action.subactions === undefined,
    );
    expect(nestedPicks.length).toBeGreaterThan(0);
    expect(nestedPicks.every((action) => action.attributes?.keepsMenuPresented === expected)).toBe(
      true,
    );
  });

  it("sections models by provider only when multiple groups are offered", () => {
    const codexModels = [modelOption("gpt-current", { isDefault: true })];
    const claudeModels = [modelOption("fable-5", { providerKey: "claude" })];
    const menu = buildThreadSettingsMenu({
      providerGroups: [group(codexModels), group(claudeModels)],
      selectedModel: codexModels[0]?.selection ?? null,
      optionDescriptors: [],
      runtimeMode: "auto",
    });

    const modelItems = menu.actions.find((action) => action.title === "Model")?.subactions ?? [];
    expect(
      modelItems.map((action) => ({ title: action.title, inline: action.displayInline ?? false })),
    ).toEqual([
      { title: "Codex", inline: true },
      { title: "Claude", inline: true },
    ]);
    const claudeSection = modelItems.find((action) => action.title === "Claude");
    expect(claudeSection?.subactions?.map((action) => action.title)).toEqual(["fable-5"]);
  });

  const eventTypes = (menu: ReturnType<typeof buildThreadSettingsMenu>) => {
    const types = new Set<ThreadSettingsMenuEvent["type"]>();
    for (const event of menu.events.values()) {
      types.add(event.type);
    }
    return types;
  };

  it("registers an event for every leaf action id", () => {
    const menu = buildThreadSettingsMenu(baseInput());
    const leafIds: string[] = [];
    const collect = (items: ReadonlyArray<{ id?: string; subactions?: unknown[] }>) => {
      for (const item of items) {
        if (Array.isArray(item.subactions) && item.subactions.length > 0) {
          collect(item.subactions as ReadonlyArray<{ id?: string; subactions?: unknown[] }>);
        } else if (item.id !== undefined) {
          leafIds.push(item.id);
        }
      }
    };
    collect(menu.actions);

    for (const id of leafIds) {
      expect(menu.events.get(id), `missing event for ${id}`).toBeDefined();
    }
    expect(eventTypes(menu)).toEqual(new Set(["select-model", "set-option", "set-runtime"]));
  });
});
