import {
  ANTIGRAVITY_DEFAULT_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "@t3tools/shared/model";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import { getComposerProviderState } from "./components/chat/composerProviderState";
import { resolveComposerProviderSelection } from "./components/ChatView.logic";
import {
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  providerInstanceEntriesFor,
} from "./providerInstances";
import {
  defaultModelSelectionsAreMixed,
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
  resolveEffectiveDefaultModelSelection,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
  supportsTextGeneration?: boolean;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
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

describe("scoped default model selections", () => {
  // regression: #27997 equal automatic defaults can resolve to different providers
  it("compares automatic defaults using each environment's models", () => {
    const codex = {
      projectId: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
      providers: [provider({ instanceId: "codex", models: ["gpt-6-astra"] })],
    };
    const claude = {
      projectId: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
      providers: [
        provider({
          instanceId: "claudeAgent",
          provider: ProviderDriverKind.make("claudeAgent"),
          models: ["claude-sonnet-4-6"],
        }),
      ],
    };

    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [codex, claude])).toBe(true);
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [claude, codex])).toBe(true);
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [codex, codex])).toBe(false);
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [claude])).toBe(false);
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [])).toBe(false);
    expect(
      defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [codex, { ...codex, providers: [] }]),
    ).toBe(true);
    expect(
      defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
        codex,
        { ...codex, providers: [provider({ instanceId: "codex", models: ["gpt-6-sol"] })] },
      ]),
    ).toBe(true);

    const projectId = ProjectId.make("claude-only");
    const project = {
      projectId,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [projectId]: {
            providerInstances: { [ProviderInstanceId.make("codex")]: { enabled: false } },
          },
        },
      },
      providers: [...codex.providers, ...claude.providers],
    };
    const remoteProject = { ...claude, projectId: ProjectId.make("remote-project") };
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [project, remoteProject])).toBe(
      false,
    );
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [remoteProject, project])).toBe(
      false,
    );
    expect(
      defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
        project,
        { ...project, projectId: ProjectId.make("other-project") },
      ]),
    ).toBe(true);

    const configured = {
      projectId: null,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerModelPreferences: {
          [ProviderInstanceId.make("codex")]: {
            hiddenModels: ["gpt-6-astra"],
            modelOrder: [],
          },
        },
      },
      providers: [provider({ instanceId: "codex", models: ["gpt-6-astra", "gpt-6-sol"] })],
    };
    const inherited = { ...configured, settings: DEFAULT_SERVER_SETTINGS };
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [configured, inherited])).toBe(
      true,
    );
    expect(defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [inherited, configured])).toBe(
      true,
    );
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      providerModelPreferences: configured.settings.providerModelPreferences,
    };
    expect(defaultModelSelectionsAreMixed(clientSettings, [configured, inherited])).toBe(false);
    expect(defaultModelSelectionsAreMixed(clientSettings, [inherited, configured])).toBe(false);
    expect(
      defaultModelSelectionsAreMixed(clientSettings, [
        { ...inherited, settings: { ...DEFAULT_SERVER_SETTINGS, providerModelPreferences: {} } },
        inherited,
      ]),
    ).toBe(true);
  });

  it("keeps automatic, explicit, and different saved options distinct", () => {
    const providers = [provider({ instanceId: "codex", models: ["gpt-6-astra"] })];
    const selected = {
      projectId: null,
      providers,
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        defaultModelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-6-astra",
        ),
      },
    };
    expect(
      defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [selected, { ...selected }]),
    ).toBe(false);
    expect(
      defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
        selected,
        { projectId: null, providers, settings: DEFAULT_UNIFIED_SETTINGS },
      ]),
    ).toBe(true);
    expect(
      defaultModelSelectionsAreMixed(DEFAULT_CLIENT_SETTINGS, [
        selected,
        {
          ...selected,
          settings: {
            ...selected.settings,
            defaultModelSelection: {
              ...selected.settings.defaultModelSelection,
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
          },
        },
      ]),
    ).toBe(true);
  });
});

describe("instance-scoped model selection", () => {
  describe.each([
    {
      driverName: "opencode",
      availableModel: "opencode/big-pickle",
      missingModel: "opencode/kimi-k3",
    },
    {
      driverName: "antigravity",
      availableModel: "gemini-3.1-pro",
      missingModel: "gemini-3.1-pro-high",
    },
  ])("$driverName catalog gaps", ({ driverName, availableModel, missingModel }) => {
    it("preserves a selected model when a catalog refresh no longer contains it", () => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make(driverName),
          instanceId: driverName,
          models: [availableModel],
        }),
      ];

      expect(
        resolveAppModelSelectionForInstance(
          ProviderInstanceId.make(driverName),
          settingsWithProviderInstances(),
          providers,
          missingModel,
          { preserveUnavailableSelection: true },
        ),
      ).toBe(missingModel);
      expect(
        resolveAppModelSelectionForInstance(
          ProviderInstanceId.make(driverName),
          settingsWithProviderInstances(),
          providers,
          missingModel,
        ),
      ).toBe(availableModel);
    });

    it("adds the selected missing model as an unavailable option", () => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make(driverName),
          instanceId: driverName,
          models: [availableModel],
        }),
      ];
      const entry = deriveProviderInstanceEntries(providers)[0]!;

      expect(
        getAppModelOptionsForInstance(settingsWithProviderInstances(), entry, missingModel),
      ).toEqual([
        expect.objectContaining({ slug: availableModel }),
        expect.objectContaining({
          slug: missingModel,
          name: missingModel,
          isUnavailable: true,
        }),
      ]);
    });

    it("does not resurrect a hidden model when the raw catalog omits it", () => {
      const instanceId = ProviderInstanceId.make(driverName);
      const driver = ProviderDriverKind.make(driverName);
      const settings: UnifiedSettings = {
        ...settingsWithProviderInstances(),
        providerModelPreferences: {
          [instanceId]: {
            hiddenModels: [missingModel],
            modelOrder: [],
          },
        },
      };
      const providers = [provider({ provider: driver, instanceId, models: [] })];
      const entry = deriveProviderInstanceEntries(providers)[0]!;

      expect(getAppModelOptionsForInstance(settings, entry, missingModel)).toEqual([]);
      expect(
        resolveAppModelSelectionForInstance(instanceId, settings, providers, missingModel, {
          preserveUnavailableSelection: true,
        }),
      ).toBeNull();
    });
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

  it("offers and resolves every saved custom model, past the first 32", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];
    const customModels = Array.from({ length: 40 }, (_, index) => `proxy/model-${index + 1}`);
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("claude_openrouter")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels },
        },
      },
    };
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settings, openrouter).map((option) => option.slug),
    ).toEqual(customModels);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settings,
        providers,
        "proxy/model-40",
      ),
    ).toBe("proxy/model-40");
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

  it("preserves the Antigravity model in drafts and existing threads after sign-out", () => {
    const instanceId = ProviderInstanceId.make("antigravity_work");
    const driver = ProviderDriverKind.make("antigravity");
    const saved = createModelSelection(instanceId, "gemini-3.1-pro-high");
    const providers = [
      {
        ...provider({ provider: driver, instanceId, models: [] }),
        status: "error" as const,
        auth: { status: "unauthenticated" as const },
      },
    ];
    for (const draft of [
      null,
      { activeProvider: instanceId, modelSelectionByProvider: { [instanceId]: saved } },
    ]) {
      const state = deriveEffectiveComposerModelState({
        draft,
        providers,
        selectedProvider: driver,
        selectedInstanceId: instanceId,
        threadModelSelection: saved,
        projectModelSelection: null,
        settings: settingsWithProviderInstances(),
      });
      expect(state.selectedModel).toBe(saved.model);
    }
  });

  it("does not borrow a default model while a new Antigravity account has no catalog", () => {
    const driver = ProviderDriverKind.make("antigravity");
    const instanceId = ProviderInstanceId.make("antigravity_work");
    const providers = [
      provider({ instanceId: "codex", models: ["gpt-5.6-sol"] }),
      provider({ provider: driver, instanceId: "antigravity", models: ["gemini-other-account"] }),
      provider({ provider: driver, instanceId, models: [] }),
    ];

    const otherAccountId = ProviderInstanceId.make("antigravity");
    for (const draft of [
      null,
      {
        activeProvider: instanceId,
        modelSelectionByProvider: {
          [otherAccountId]: createModelSelection(otherAccountId, "gemini-other-account"),
        },
      },
    ]) {
      const state = deriveEffectiveComposerModelState({
        draft,
        providers,
        selectedProvider: driver,
        selectedInstanceId: instanceId,
        threadModelSelection: null,
        projectModelSelection: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.6-sol",
        ),
        settings: settingsWithProviderInstances(),
      });
      expect(state.selectedModel).toBe("");
    }
  });

  it("offers only account catalog models for Antigravity despite custom model settings", () => {
    const driver = ProviderDriverKind.make("antigravity");
    const customId = ProviderInstanceId.make("antigravity_work");
    const nativeModel = "gemini-3.1-pro";
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("antigravity")]: {
          driver,
          config: { customModels: ["api-only-model"] },
        },
        [customId]: { driver, config: { customModels: ["unknown-model"] } },
      },
    };
    const entries = deriveProviderInstanceEntries([
      provider({ provider: driver, instanceId: "antigravity", models: [nativeModel] }),
      provider({ provider: driver, instanceId: customId, models: [nativeModel] }),
    ]);

    for (const entry of entries) {
      expect(getAppModelOptionsForInstance(settings, entry).map((model) => model.slug)).toEqual([
        nativeModel,
      ]);
    }
  });

  it("resolves the Antigravity default marker without creating an unavailable model", () => {
    const instanceId = ProviderInstanceId.make("antigravity_work");
    const nativeModel = "gemini-3.1-pro";
    const base = provider({
      provider: ProviderDriverKind.make("antigravity"),
      instanceId,
      models: [nativeModel],
    });
    const liveProvider = {
      ...base,
      models: base.models.map((model) => ({
        ...model,
        isDefault: true,
        aliases: [ANTIGRAVITY_DEFAULT_MODEL],
      })),
    };
    const settings = settingsWithProviderInstances();

    expect(
      getAppModelOptionsForInstance(
        settings,
        deriveProviderInstanceEntries([liveProvider])[0]!,
        ANTIGRAVITY_DEFAULT_MODEL,
      ).map((model) => model.slug),
    ).toEqual([nativeModel]);
    expect(
      resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        [liveProvider],
        ANTIGRAVITY_DEFAULT_MODEL,
        {
          preserveUnavailableSelection: true,
        },
      ),
    ).toBe(nativeModel);

    const hiddenSettings: UnifiedSettings = {
      ...settings,
      providerModelPreferences: {
        [instanceId]: { hiddenModels: [nativeModel], modelOrder: [] },
      },
    };
    expect(
      resolveAppModelSelectionForInstance(
        instanceId,
        hiddenSettings,
        [liveProvider],
        ANTIGRAVITY_DEFAULT_MODEL,
        { preserveUnavailableSelection: true },
      ),
    ).toBeNull();
    expect(
      getAppModelOptionsForInstance(
        settings,
        deriveProviderInstanceEntries([{ ...base, models: [] }])[0]!,
        ANTIGRAVITY_DEFAULT_MODEL,
      ),
    ).toEqual([]);
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

  it("keeps the default instance's draft model off a custom instance of the same driver", () => {
    const driver = ProviderDriverKind.make("opencode");
    const defaultInstanceId = ProviderInstanceId.make("opencode");
    const kimiInstanceId = ProviderInstanceId.make("kimi_api");
    const kimiModel = "kimi-code-plan-global/k3.1-pro";
    const providers = [
      provider({
        provider: driver,
        instanceId: defaultInstanceId,
        models: ["opencode-go/kimi-k3.1-pro"],
      }),
      provider({ provider: driver, instanceId: kimiInstanceId, models: [kimiModel] }),
    ];
    const state = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: kimiInstanceId,
        modelSelectionByProvider: {
          [defaultInstanceId]: createModelSelection(defaultInstanceId, "opencode-go/kimi-k3.1-pro"),
        },
      },
      providers,
      selectedProvider: driver,
      selectedInstanceId: kimiInstanceId,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(state.selectedModel).toBe(kimiModel);
  });
});
