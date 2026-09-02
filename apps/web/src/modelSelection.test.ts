import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "@t3tools/shared/model";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  getCustomModelOptionsByInstance,
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
  resolvePlanAgentHealPatch,
  withoutPlanAgentSelection,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection", () => {
  it("preserves server-provided legacy model metadata", () => {
    const baseProvider = provider({
      instanceId: "claudeAgent",
      models: ["claude-opus-4-8"],
    });
    const providers = [
      {
        ...baseProvider,
        models: [{ ...baseProvider.models[0]!, isLegacy: true }],
      },
    ];
    const stock = deriveProviderInstanceEntries(providers)[0]!;

    expect(getAppModelOptionsForInstance(settingsWithProviderInstances(), stock)[0]?.isLegacy).toBe(
      true,
    );
  });

  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug against the selected custom instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: ["claude-opus-4-8"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("claude_openrouter")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["opus"] },
        },
      },
    };
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settings, openrouter).map((option) => option.slug),
    ).toEqual(["claude-opus-4-8", "opus"]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settings,
        providers,
        "opus",
      ),
    ).toBe("opus");
  });

  it("includes Grok custom models from the selected provider instance", () => {
    const providers = [provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok" })];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          config: { customModels: ["grok-test-custom-model"] },
        },
      },
    };
    const grok = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "grok",
    )!;

    expect(getAppModelOptionsForInstance(settings, grok).map((option) => option.slug)).toContain(
      "grok-test-custom-model",
    );
  });

  it("does not inject an unknown selected slug into the stock instance list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("drops server-reported custom rows that are no longer in settings", () => {
    const baseProvider = provider({
      instanceId: "claude_openrouter",
      models: ["claude-sonnet-4-6"],
    });
    const providers = [
      {
        ...baseProvider,
        models: [
          ...baseProvider.models,
          { slug: "removed/custom", name: "removed/custom", isCustom: true, capabilities: {} },
        ],
      },
    ];
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toEqual(["claude-sonnet-4-6", "openai/gpt-5.5"]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
        { preserveUnavailableSelection: true },
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("preserves an existing OpenCode model when a catalog refresh no longer contains it", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        models: ["opencode/big-pickle"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("opencode"),
        settingsWithProviderInstances(),
        providers,
        "opencode/kimi-k3",
        { preserveUnavailableSelection: true },
      ),
    ).toBe("opencode/kimi-k3");
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("opencode"),
        settingsWithProviderInstances(),
        providers,
        "opencode/kimi-k3",
      ),
    ).toBe("opencode/big-pickle");
  });

  it("adds the selected missing OpenCode model as an unavailable option", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
        models: ["opencode/big-pickle"],
      }),
    ];
    const entry = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), entry, "opencode/kimi-k3"),
    ).toEqual([
      expect.objectContaining({ slug: "opencode/big-pickle" }),
      expect.objectContaining({
        slug: "opencode/kimi-k3",
        name: "opencode/kimi-k3",
        isUnavailable: true,
      }),
    ]);
  });

  it("keeps a missing OpenCode option scoped to the selected instance", () => {
    const selectedInstanceId = ProviderInstanceId.make("opencode_work");
    const otherInstanceId = ProviderInstanceId.make("opencode_personal");
    const driver = ProviderDriverKind.make("opencode");
    const providers = [
      provider({ provider: driver, instanceId: selectedInstanceId, models: [] }),
      provider({ provider: driver, instanceId: otherInstanceId, models: [] }),
    ];
    const options = getCustomModelOptionsByInstance(
      settingsWithProviderInstances(),
      providers,
      selectedInstanceId,
      "openrouter/kimi-k3",
    );

    expect(options.get(selectedInstanceId)).toEqual([
      expect.objectContaining({ slug: "openrouter/kimi-k3", isUnavailable: true }),
    ]);
    expect(options.get(otherInstanceId)).toEqual([]);
  });

  it("replaces the unavailable marker with catalog metadata after recovery", () => {
    const instanceId = ProviderInstanceId.make("opencode");
    const driver = ProviderDriverKind.make("opencode");
    const selectedModel = "opencode/kimi-k3";
    const pendingProviders = [
      provider({ provider: driver, instanceId, models: ["opencode/big-pickle"] }),
    ];
    const recoveredProviders = [
      provider({ provider: driver, instanceId, models: ["opencode/big-pickle", selectedModel] }),
    ];

    expect(
      getAppModelOptionsForInstance(
        settingsWithProviderInstances(),
        deriveProviderInstanceEntries(pendingProviders)[0]!,
        selectedModel,
      ).find((option) => option.slug === selectedModel)?.isUnavailable,
    ).toBe(true);
    expect(
      getAppModelOptionsForInstance(
        settingsWithProviderInstances(),
        deriveProviderInstanceEntries(recoveredProviders)[0]!,
        selectedModel,
      ).find((option) => option.slug === selectedModel)?.isUnavailable,
    ).toBeUndefined();
    expect(
      resolveAppModelSelectionForInstance(
        instanceId,
        settingsWithProviderInstances(),
        recoveredProviders,
        selectedModel,
        { preserveUnavailableSelection: true },
      ),
    ).toBe(selectedModel);
  });

  it("does not resurrect a hidden OpenCode model when the raw catalog omits it", () => {
    const instanceId = ProviderInstanceId.make("opencode");
    const driver = ProviderDriverKind.make("opencode");
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [instanceId]: {
          hiddenModels: ["opencode/kimi-k3"],
          modelOrder: [],
        },
      },
    };
    const providers = [provider({ provider: driver, instanceId, models: [] })];
    const entry = deriveProviderInstanceEntries(providers)[0]!;

    expect(getAppModelOptionsForInstance(settings, entry, "opencode/kimi-k3")).toEqual([]);
    expect(
      resolveAppModelSelectionForInstance(instanceId, settings, providers, "opencode/kimi-k3", {
        preserveUnavailableSelection: true,
      }),
    ).toBeNull();
  });

  it("does not add unavailable options for other providers", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        models: ["gpt-5.6-sol"],
      }),
    ];
    const entry = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), entry, "gpt-missing").map(
        (option) => option.slug,
      ),
    ).toEqual(["gpt-5.6-sol"]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("codex"),
        settingsWithProviderInstances(),
        providers,
        "gpt-missing",
        { preserveUnavailableSelection: true },
      ),
    ).toBe("gpt-5.6-sol");
  });

  it("falls back from an explicit non-OpenCode draft with a missing model", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const providers = [provider({ provider: driver, instanceId, models: ["gpt-5.6-sol"] })];
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: instanceId,
        modelSelectionByProvider: {
          [instanceId]: createModelSelection(instanceId, "gpt-missing", [
            { id: "effort", value: "max" },
          ]),
        },
      },
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: settingsWithProviderInstances(),
    });
    const dispatch = getComposerProviderState({
      provider: driver,
      model: state.selectedModel,
      models: providers[0]!.models,
      modelOptions: state.modelOptions?.[instanceId],
      planModeEnabled: false,
    });

    expect(state.selectedModel).toBe("gpt-5.6-sol");
    expect(dispatch.modelOptionsForDispatch).toBeUndefined();
  });

  it("preserves an explicit draft OpenCode selection while the catalog is empty", () => {
    const instanceId = ProviderInstanceId.make("opencode_work");
    const driver = ProviderDriverKind.make("opencode");
    const draftSelection = createModelSelection(instanceId, "openrouter/kimi-k3", [
      { id: "variant", value: "max" },
      { id: "agent", value: "build" },
    ]);
    const providers = [provider({ provider: driver, instanceId, models: [] })];
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: instanceId,
        modelSelectionByProvider: { [instanceId]: draftSelection },
      },
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: settingsWithProviderInstances(),
    });

    expect(state.selectedModel).toBe("openrouter/kimi-k3");
    expect(state.modelOptions?.[instanceId]).toEqual(draftSelection.options);
  });

  it("preserves saved options through dispatch when the model is absent from the catalog", () => {
    const instanceId = ProviderInstanceId.make("opencode");
    const driver = ProviderDriverKind.make("opencode");
    const providers = [provider({ provider: driver, instanceId, models: ["opencode/big-pickle"] })];
    const saved = createModelSelection(instanceId, "opencode/kimi-k3", [
      { id: "variant", value: "max" },
      { id: "agent", value: "build" },
    ]);
    const state = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection: saved,
      projectModelSelection: null,
      settings: settingsWithProviderInstances(),
    });
    const dispatch = getComposerProviderState({
      provider: driver,
      model: state.selectedModel,
      models: providers[0]!.models,
      modelOptions: state.modelOptions?.[instanceId],
      planModeEnabled: false,
    });

    expect(
      createModelSelection(instanceId, state.selectedModel, dispatch.modelOptionsForDispatch),
    ).toEqual(saved);
  });

  it("keeps a custom-instance draft model while dropping unsupported options", () => {
    const instanceId = ProviderInstanceId.make("claude_openrouter");
    const driver = ProviderDriverKind.make("claudeAgent");
    const providers = [
      provider({ provider: driver, instanceId: "claudeAgent", models: ["claude-opus-5"] }),
      provider({ provider: driver, instanceId, models: ["claude-opus-5"] }),
    ];
    const threadSelection = createModelSelection(instanceId, "claude-opus-5", [
      { id: "effort", value: "high" },
    ]);
    const draftSelection = createModelSelection(instanceId, "openai/gpt-5.5", [
      { id: "effort", value: "max" },
    ]);
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: instanceId,
        modelSelectionByProvider: { [instanceId]: draftSelection },
      },
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection: threadSelection,
      projectModelSelection: null,
      settings: settingsWithProviderInstances(),
    });
    const dispatch = getComposerProviderState({
      provider: driver,
      model: state.selectedModel,
      models: providers[1]!.models,
      modelOptions: state.modelOptions?.[instanceId],
      planModeEnabled: false,
    });

    expect(
      createModelSelection(instanceId, state.selectedModel, dispatch.modelOptionsForDispatch),
    ).toEqual(createModelSelection(instanceId, "openai/gpt-5.5"));
  });

  it("preserves custom provider instances in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });
});

describe("withoutPlanAgentSelection", () => {
  const instance = ProviderInstanceId.make("opencode");
  const model = "opencode/gpt-5.4";

  it("drops a stored plan agent option", () => {
    const selection = createModelSelection(instance, model, [
      { id: "variant", value: "high" },
      { id: "agent", value: "plan" },
    ]);
    expect(withoutPlanAgentSelection(selection)).toEqual(
      createModelSelection(instance, model, [{ id: "variant", value: "high" }]),
    );
  });

  it("keeps non-plan agent options", () => {
    const selection = createModelSelection(instance, model, [{ id: "agent", value: "build" }]);
    expect(withoutPlanAgentSelection(selection)).toBe(selection);
  });

  it("omits options entirely when plan was the only stored option", () => {
    const selection = createModelSelection(instance, model, [{ id: "agent", value: "plan" }]);
    expect(withoutPlanAgentSelection(selection)).toEqual({ instanceId: instance, model });
  });

  it("returns null and undefined selections unchanged", () => {
    expect(withoutPlanAgentSelection(null)).toBeNull();
    expect(withoutPlanAgentSelection(undefined)).toBeUndefined();
  });
});

describe("resolvePlanAgentHealPatch", () => {
  const instance = ProviderInstanceId.make("opencode");
  const model = "opencode/gpt-5.4";
  const healed = createModelSelection(instance, model, [{ id: "variant", value: "high" }]);
  const storedPlan = createModelSelection(instance, model, [
    { id: "variant", value: "high" },
    { id: "agent", value: "plan" },
  ]);
  const nullPatch = {
    planModeEnabled: true,
    textGenerationModelSelection: storedPlan,
    sourceControlWriterModelSelection: null,
  };

  it("returns null when plan mode is on", () => {
    expect(resolvePlanAgentHealPatch(nullPatch)).toBeNull();
  });

  it("returns null when nothing needs healing", () => {
    expect(
      resolvePlanAgentHealPatch({
        planModeEnabled: false,
        textGenerationModelSelection: healed,
        sourceControlWriterModelSelection: null,
      }),
    ).toBeNull();
  });

  it("patches the stored text generation selection to drop the plan agent", () => {
    expect(
      resolvePlanAgentHealPatch({
        planModeEnabled: false,
        textGenerationModelSelection: storedPlan,
        sourceControlWriterModelSelection: null,
      }),
    ).toEqual({ textGenerationModelSelection: healed });
  });

  it("patches a stored source control writer selection that uses the plan agent", () => {
    expect(
      resolvePlanAgentHealPatch({
        planModeEnabled: false,
        textGenerationModelSelection: healed,
        sourceControlWriterModelSelection: storedPlan,
      }),
    ).toEqual({ sourceControlWriterModelSelection: healed });
  });
});
