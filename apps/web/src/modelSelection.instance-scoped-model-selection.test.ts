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

  it("self-heals a persisted selection pointing at a text-generation-incapable instance", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("acpRegistry"),
        instanceId: "acp_gemini",
        models: ["default"],
        supportsTextGeneration: false,
      }),
      provider({
        instanceId: "codex",
        models: ["gpt-5.6-luna"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("acp_gemini"),
        model: "default",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers).instanceId).toBe(
      ProviderInstanceId.make("codex"),
    );
  });

  it("falls back to the text generation default, not the chat default, for a removed model", () => {
    const codex = provider({ instanceId: "codex", models: ["gpt-6-astra", "gpt-6-luna"] });
    const providers = [
      { ...codex, models: codex.models.map((m, i) => (i === 0 ? { ...m, isDefault: true } : m)) },
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.6-luna",
      ),
    };

    expect(resolveAppModelSelectionState(settings, providers).model).toBe(
      DEFAULT_TEXT_GENERATION_MODEL,
    );
  });

  it("does not select a provider that cannot generate system text", () => {
    const instanceId = ProviderInstanceId.make("antigravity");
    const unsupported = {
      ...provider({
        provider: ProviderDriverKind.make("antigravity"),
        instanceId,
        models: ["gemini-3.1-pro"],
      }),
      supportsTextGeneration: false,
    };
    const supported = provider({ instanceId: "codex", models: ["gpt-5.6-sol"] });
    const settings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: createModelSelection(instanceId, "gemini-3.1-pro"),
    };

    expect(resolveAppModelSelectionState(settings, [unsupported, supported])).toEqual(
      createModelSelection(supported.instanceId, "gpt-5.6-sol"),
    );
    expect(resolveAppModelSelectionState(settings, [unsupported])).toEqual(
      NO_PROVIDER_MODEL_SELECTION,
    );
  });
});

describe("resolveAppModelSelectionState with the opencode plan agent", () => {
  const instanceId = ProviderInstanceId.make("opencode");
  const model = "opencode/gpt-5.4";
  const opencode: ServerProvider = {
    ...provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "agent",
              label: "Agent",
              type: "select",
              options: [
                { id: "build", label: "Build", isDefault: true },
                { id: "plan", label: "Plan" },
              ],
              currentValue: "build",
            },
          ],
        },
      },
    ],
  };
  const settings: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    planModeEnabled: false,
    textGenerationModelSelection: createModelSelection(instanceId, model, [
      { id: "agent", value: "plan" },
    ]),
  };

  it("keeps a stored plan agent this device did not pick", () => {
    expect(resolveAppModelSelectionState(settings, [opencode])).toEqual(
      createModelSelection(instanceId, model, [{ id: "agent", value: "plan" }]),
    );
  });
});

describe("default model settings and new-thread composer parity", () => {
  it.each([
    ["hidden", "claudeAgent", "claude-opus-5", "claude-opus-5-5", "medium"],
    ["visible", "claudeAgent", "claude-opus-5", "claude-opus-5", "max"],
    ["unavailable", "opencode", "openrouter/kimi-k3", "openrouter/kimi-k3", null],
  ] as const)(
    "resolves the %s default and its traits",
    (visibility, kind, model, expectedModel, effort) => {
      const driver = ProviderDriverKind.make(kind);
      const instanceId = ProviderInstanceId.make(`${kind}_work`);
      const snapshot = provider({ provider: driver, instanceId });
      const models: ServerProvider["models"] = ["claude-opus-5-5", "claude-opus-5"].map(
        (slug, index) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: (index === 0 ? ["medium", "high"] : ["high", "max"]).map(
                  (id, optionIndex) => ({ id, label: id, isDefault: optionIndex === 0 }),
                ),
              },
            ],
          },
        }),
      );
      const providers = [{ ...snapshot, models }];
      const stored = createModelSelection(instanceId, model, [{ id: "effort", value: "max" }]);
      const settings: UnifiedSettings = {
        ...settingsWithProviderInstances(),
        providerModelPreferences: {
          [instanceId]: { hiddenModels: visibility === "hidden" ? [model] : [], modelOrder: [] },
        },
      };
      // ChatView builds the local draft with the project default as its thread selection.
      const composer = deriveEffectiveComposerModelState({
        draft: null,
        providers,
        selectedProvider: driver,
        selectedInstanceId: instanceId,
        threadModelSelection: stored,
        projectModelSelection: stored,
        settings,
      });
      const effective = resolveEffectiveDefaultModelSelection(settings, providers, stored);
      const traits = (model: string, modelOptions: typeof stored.options) =>
        getComposerProviderState({
          provider: driver,
          model,
          models,
          modelOptions,
          planModeEnabled: settings.planModeEnabled,
        });
      const composerTraits = traits(composer.selectedModel, composer.modelOptions?.[instanceId]);

      expect(composer.selectedModel).toBe(expectedModel);
      expect(traits(effective.model, effective.options)).toEqual(composerTraits);
      expect(effective).toEqual({ ...stored, model: composer.selectedModel });
      expect(composerTraits.promptEffort).toBe(effort);
    },
  );
});

describe("composer fallback to another instance of the same driver", () => {
  const claude = ProviderDriverKind.make("claudeAgent");

  const codex = ProviderDriverKind.make("codex");

  const disabled = ProviderInstanceId.make("claudeAgent");

  const fallback = ProviderInstanceId.make("claude_team");

  const effortModels: ServerProvider["models"] = [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: ["medium", "high", "xhigh"].map((id) => ({
              id,
              label: id,
              isDefault: id === "medium",
            })),
          },
        ],
      },
    },
  ];

  const providers: ReadonlyArray<ServerProvider> = [
    {
      ...provider({ provider: claude, instanceId: disabled }),
      enabled: false,
      models: effortModels,
    },
    { ...provider({ provider: claude, instanceId: fallback }), models: effortModels },
  ];

  const picked = createModelSelection(disabled, "claude-opus-5-5", [
    { id: "effort", value: "xhigh" },
  ]);

  function composerFor(input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly draft?: Parameters<typeof deriveEffectiveComposerModelState>[0]["draft"];
    readonly threadModelSelection: ReturnType<typeof createModelSelection>;
    readonly customModels?: Partial<Record<string, ReadonlyArray<string>>>;
  }) {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: Object.fromEntries(
        input.providers.map((provider) => [
          provider.instanceId,
          {
            driver: provider.driver,
            enabled: provider.enabled,
            config: {
              customModels: (input.customModels?.[provider.instanceId] ?? []).map((slug) => ({
                slug,
                name: slug,
                capabilities: null,
              })),
            },
          },
        ]),
      ),
    };
    const selection = resolveComposerProviderSelection({
      entries: providerInstanceEntriesFor(input.providers, settings, null),
      candidateInstanceIds: [input.threadModelSelection.instanceId],
      lockedProvider: null,
      lockedInstanceId: undefined,
    });
    const selectedInstanceId = selection.selectedProviderEntry!.instanceId;
    const selectedProvider = selection.selectedProviderEntry!.driverKind;
    const state = deriveEffectiveComposerModelState({
      draft: input.draft ?? null,
      providers: input.providers,
      selectedProvider,
      selectedInstanceId,
      requestedInstanceId: selection.requestedInstanceId,
      threadModelSelection: input.threadModelSelection,
      projectModelSelection: null,
      settings,
    });
    const traits = getComposerProviderState({
      provider: selectedProvider,
      model: state.selectedModel,
      models: selection.selectedProviderEntry!.models,
      modelOptions: state.modelOptions?.[selectedInstanceId],
      planModeEnabled: false,
    });
    return { selectedInstanceId, state, traits };
  }

  it("keeps the requested instance's effort on the fallback instance", () => {
    const { selectedInstanceId, state, traits } = composerFor({
      providers,
      threadModelSelection: picked,
    });

    expect(selectedInstanceId).toBe(fallback);
    expect(state.selectedModel).toBe("claude-opus-5-5");
    expect(traits.promptEffort).toBe("xhigh");
    expect(
      createModelSelection(fallback, state.selectedModel, traits.modelOptionsForDispatch),
    ).toEqual(
      createModelSelection(fallback, "claude-opus-5-5", [{ id: "effort", value: "xhigh" }]),
    );
  });

  it("keeps options the fallback instance already has", () => {
    const { traits } = composerFor({
      providers,
      threadModelSelection: picked,
      draft: {
        activeProvider: disabled,
        modelSelectionByProvider: {
          [disabled]: picked,
          [fallback]: createModelSelection(fallback, "claude-opus-5-5", [
            { id: "effort", value: "high" },
          ]),
        },
      },
    });

    expect(traits.promptEffort).toBe("high");
  });

  it("does not carry options picked with another model", () => {
    // An optionless draft pick takes its options from the thread, which holds another model.
    const { state, traits } = composerFor({
      providers,
      threadModelSelection: createModelSelection(disabled, "claude-sonnet-4-6", [
        { id: "effort", value: "high" },
      ]),
      draft: {
        activeProvider: disabled,
        modelSelectionByProvider: { [disabled]: createModelSelection(disabled, "claude-opus-5-5") },
      },
    });

    expect(state.selectedModel).toBe("claude-opus-5-5");
    expect(traits.promptEffort).toBe("medium");
    expect(traits.modelOptionsForDispatch).toBeUndefined();
  });

  it("does not carry options to another driver", () => {
    const codexOnly: ReadonlyArray<ServerProvider> = [
      {
        ...provider({ provider: claude, instanceId: disabled }),
        enabled: false,
        models: effortModels,
      },
      provider({ provider: codex, instanceId: "codex", models: ["gpt-6-astra"] }),
    ];
    const { selectedInstanceId, state } = composerFor({
      providers: codexOnly,
      threadModelSelection: picked,
    });

    expect(selectedInstanceId).toBe(ProviderInstanceId.make("codex"));
    expect(state.modelOptions?.[selectedInstanceId]).toBeUndefined();
  });
});

describe("composer fallback to another instance of the same driver", () => {
  const claude = ProviderDriverKind.make("claudeAgent");

  const codex = ProviderDriverKind.make("codex");

  const disabled = ProviderInstanceId.make("claudeAgent");

  const fallback = ProviderInstanceId.make("claude_team");

  const effortModels: ServerProvider["models"] = [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: ["medium", "high", "xhigh"].map((id) => ({
              id,
              label: id,
              isDefault: id === "medium",
            })),
          },
        ],
      },
    },
  ];

  const providers: ReadonlyArray<ServerProvider> = [
    {
      ...provider({ provider: claude, instanceId: disabled }),
      enabled: false,
      models: effortModels,
    },
    { ...provider({ provider: claude, instanceId: fallback }), models: effortModels },
  ];

  const picked = createModelSelection(disabled, "claude-opus-5-5", [
    { id: "effort", value: "xhigh" },
  ]);

  function composerFor(input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly draft?: Parameters<typeof deriveEffectiveComposerModelState>[0]["draft"];
    readonly threadModelSelection: ReturnType<typeof createModelSelection>;
    readonly customModels?: Partial<Record<string, ReadonlyArray<string>>>;
  }) {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: Object.fromEntries(
        input.providers.map((provider) => [
          provider.instanceId,
          {
            driver: provider.driver,
            enabled: provider.enabled,
            config: {
              customModels: (input.customModels?.[provider.instanceId] ?? []).map((slug) => ({
                slug,
                name: slug,
                capabilities: null,
              })),
            },
          },
        ]),
      ),
    };
    const selection = resolveComposerProviderSelection({
      entries: providerInstanceEntriesFor(input.providers, settings, null),
      candidateInstanceIds: [input.threadModelSelection.instanceId],
      lockedProvider: null,
      lockedInstanceId: undefined,
    });
    const selectedInstanceId = selection.selectedProviderEntry!.instanceId;
    const selectedProvider = selection.selectedProviderEntry!.driverKind;
    const state = deriveEffectiveComposerModelState({
      draft: input.draft ?? null,
      providers: input.providers,
      selectedProvider,
      selectedInstanceId,
      requestedInstanceId: selection.requestedInstanceId,
      threadModelSelection: input.threadModelSelection,
      projectModelSelection: null,
      settings,
    });
    const traits = getComposerProviderState({
      provider: selectedProvider,
      model: state.selectedModel,
      models: selection.selectedProviderEntry!.models,
      modelOptions: state.modelOptions?.[selectedInstanceId],
      planModeEnabled: false,
    });
    return { selectedInstanceId, state, traits };
  }

describe("with model aliases", () => {
    const reasoningModel = (
      slug: string,
      id: string,
      extra: Partial<ServerProvider["models"][number]> = {},
    ): ServerProvider["models"][number] => ({
      slug,
      name: slug,
      isCustom: false,
      ...extra,
      capabilities: {
        optionDescriptors: [
          {
            id,
            label: id,
            type: "select",
            options: ["medium", "high", "xhigh"].map((value) => ({
              id: value,
              label: value,
              isDefault: value === "medium",
            })),
          },
        ],
      },
    });

    it.each([
      ["5.4", "gpt-5.4"],
      ["gpt-5-codex", "gpt-5.4"],
      ["gpt-5.4", "5.4"],
    ])("keeps the effort from %s on fallback %s", (savedModel, fallbackModel) => {
      const disabledCodex = ProviderInstanceId.make("codex");
      const fallbackCodex = ProviderInstanceId.make("codex_team");
      const models = [reasoningModel(fallbackModel, "reasoningEffort")];
      const { selectedInstanceId, state, traits } = composerFor({
        providers: [
          { ...provider({ provider: codex, instanceId: disabledCodex }), enabled: false, models },
          { ...provider({ provider: codex, instanceId: fallbackCodex }), models },
        ],
        threadModelSelection: createModelSelection(disabledCodex, savedModel, [
          { id: "reasoningEffort", value: "xhigh" },
        ]),
      });

      expect(selectedInstanceId).toBe(fallbackCodex);
      expect(state.selectedModel).toBe(fallbackModel);
      expect(traits.promptEffort).toBe("xhigh");
    });

    it.each([
      {
        // A disabled Codex instance reports only its custom models.
        state: "disabled",
        requested: {
          enabled: false,
          models: [reasoningModel("5.4", "reasoningEffort", { isCustom: true })],
        },
      },
      {
        // An unavailable instance reports no models; its custom models are only in settings.
        state: "unavailable",
        requested: { enabled: false, availability: "unavailable" as const, models: [] },
      },
    ])(
      "does not alias-expand a custom model named 5.4 when the requested instance is $state",
      ({ requested }) => {
        const disabledCodex = ProviderInstanceId.make("codex");
        const { state, traits } = composerFor({
          providers: [
            { ...provider({ provider: codex, instanceId: disabledCodex }), ...requested },
            {
              ...provider({ provider: codex, instanceId: "codex_team" }),
              models: [reasoningModel("gpt-5.4", "reasoningEffort")],
            },
          ],
          customModels: { [disabledCodex]: ["5.4"] },
          threadModelSelection: createModelSelection(disabledCodex, "5.4", [
            { id: "reasoningEffort", value: "xhigh" },
          ]),
        });

        expect(state.selectedModel).toBe("gpt-5.4");
        expect(traits.modelOptionsForDispatch).toBeUndefined();
      },
    );

    it("does not alias-expand the fallback instance's custom model", () => {
      const { state, traits } = composerFor({
        providers: [
          { ...provider({ provider: codex, instanceId: "codex" }), enabled: false },
          {
            ...provider({ provider: codex, instanceId: "codex_team" }),
            models: [reasoningModel("5.4", "reasoningEffort", { isCustom: true })],
          },
        ],
        customModels: { codex_team: ["5.4"] },
        threadModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "xhigh" },
        ]),
      });

      expect(state.selectedModel).toBe("5.4");
      expect(traits.modelOptionsForDispatch).toBeUndefined();
    });

    it("does not carry options through an alias that names another model per instance", () => {
      // "antigravity-default" is each Antigravity instance's current model.
      const antigravity = ProviderDriverKind.make("antigravity");
      const disabledAntigravity = ProviderInstanceId.make("antigravity");
      const current = { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] };
      const { state, traits } = composerFor({
        providers: [
          {
            ...provider({ provider: antigravity, instanceId: disabledAntigravity }),
            enabled: false,
            models: [reasoningModel("gemini-3-pro", "thinking", current)],
          },
          {
            ...provider({ provider: antigravity, instanceId: "antigravity_work" }),
            models: [reasoningModel("claude-sonnet-4-6", "thinking", current)],
          },
        ],
        threadModelSelection: createModelSelection(disabledAntigravity, ANTIGRAVITY_DEFAULT_MODEL, [
          { id: "thinking", value: "high" },
        ]),
      });

      expect(state.selectedModel).toBe("claude-sonnet-4-6");
      expect(traits.modelOptionsForDispatch).toBeUndefined();
    });
});
});
