import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ModelSelection, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelMenuActions,
  buildModelOptions,
  groupByProvider,
  isSameInstanceSessionBoundChangeBlocked,
  resolveEffectiveModelSelection,
  resolveOutboxModelSelection,
  resolveOutboxModelSelectionForEnvironment,
  resolveSessionBoundModelSelectionUpdate,
  resolveSelectableModelSelection,
  startedThreadOptionChangeBlocked,
  threadShellHasStarted,
} from "./modelOptions";

describe("mobile model options", () => {
  it("folds legacy models into a provider-scoped menu", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const actions = buildModelMenuActions(groupByProvider(buildModelOptions(config, null)), null);

    expect(actions).toMatchObject([
      {
        title: "Codex",
        subactions: [{ id: "model:codex:gpt-5.6-sol", title: "GPT-5.6 Sol" }],
      },
      {
        id: "legacy-models:codex",
        title: "Codex legacy models",
        subactions: [{ id: "model:codex:gpt-5.4", title: "GPT-5.4" }],
      },
    ]);
  });

  it("omits an empty provider menu when every model is legacy", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(
      buildModelMenuActions(groupByProvider(buildModelOptions(config, null)), null),
    ).toMatchObject([
      {
        id: "legacy-models:codex",
        title: "Codex legacy models",
        subactions: [{ id: "model:codex:gpt-5.4" }],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
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
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });
});

describe("startedThreadOptionChangeBlocked", () => {
  const config = {
    providers: [
      {
        instanceId: "grok",
        driver: "grok",
        requiresNewThreadForModelChange: true,
      },
      {
        instanceId: "codex",
        driver: "codex",
      },
    ],
  } as unknown as ServerConfig;

  it("allows option changes before a provider session exists", () => {
    expect(
      startedThreadOptionChangeBlocked({
        config,
        threadHasStarted: false,
        threadRuntime: null,
        selectionInstanceId: "grok",
      }),
    ).toBe(false);
  });

  it("allows started-session option changes for unrestricted providers", () => {
    expect(
      startedThreadOptionChangeBlocked({
        config,
        threadHasStarted: true,
        threadRuntime: { providerInstanceId: "codex" },
        selectionInstanceId: "codex",
      }),
    ).toBe(false);
  });

  it("does not treat a different provider instance as the locked session", () => {
    expect(
      startedThreadOptionChangeBlocked({
        config,
        threadHasStarted: true,
        threadRuntime: { providerInstanceId: "grok" },
        selectionInstanceId: "codex",
      }),
    ).toBe(false);
  });

  it("blocks started-session option changes for session-bound providers", () => {
    expect(
      startedThreadOptionChangeBlocked({
        config,
        threadHasStarted: true,
        threadRuntime: { providerInstanceId: "grok" },
        selectionInstanceId: "grok",
      }),
    ).toBe(true);
  });

  it("blocks from committed instance metadata when runtime is temporarily absent", () => {
    expect(
      startedThreadOptionChangeBlocked({
        config,
        threadHasStarted: true,
        threadRuntime: null,
        selectionInstanceId: "grok",
      }),
    ).toBe(true);
  });
});

describe("threadShellHasStarted", () => {
  it("recognizes shell history when runtime is absent", () => {
    expect(threadShellHasStarted({ itemCount: 1, latestRun: null, runtime: null })).toBe(true);
    expect(threadShellHasStarted({ itemCount: 0, latestRun: {} as never, runtime: null })).toBe(
      true,
    );
    expect(threadShellHasStarted({ itemCount: 0, latestRun: null, runtime: null })).toBe(false);
  });
});

describe("isSameInstanceSessionBoundChangeBlocked", () => {
  it("blocks same-instance changes when the session-bound lock is active", () => {
    expect(
      isSameInstanceSessionBoundChangeBlocked({
        optionChangeBlocked: true,
        committedInstanceId: "grok",
        requestedInstanceId: "grok",
      }),
    ).toBe(true);
  });

  it("allows a different provider instance for handoff", () => {
    expect(
      isSameInstanceSessionBoundChangeBlocked({
        optionChangeBlocked: true,
        committedInstanceId: "grok",
        requestedInstanceId: "codex",
      }),
    ).toBe(false);
  });

  it("allows all changes when the lock is inactive", () => {
    expect(
      isSameInstanceSessionBoundChangeBlocked({
        optionChangeBlocked: false,
        committedInstanceId: "grok",
        requestedInstanceId: "grok",
      }),
    ).toBe(false);
  });
});

describe("resolveEffectiveModelSelection", () => {
  const committedLow: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const draftHigh: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const draftOtherModel: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-build",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const draftHandoff: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("uses committed Low when locked even if same-instance draft is High", () => {
    expect(
      resolveEffectiveModelSelection({
        draftModelSelection: draftHigh,
        committedModelSelection: committedLow,
        optionChangeBlocked: true,
      }),
    ).toEqual(committedLow);
  });

  it("keeps a legacy same-instance model draft visible instead of silently substituting", () => {
    expect(
      resolveEffectiveModelSelection({
        draftModelSelection: draftOtherModel,
        committedModelSelection: committedLow,
        optionChangeBlocked: true,
      }),
    ).toEqual(draftOtherModel);
  });

  it("keeps a cross-provider handoff draft visible while locked", () => {
    expect(
      resolveEffectiveModelSelection({
        draftModelSelection: draftHandoff,
        committedModelSelection: committedLow,
        optionChangeBlocked: true,
      }),
    ).toEqual(draftHandoff);
  });

  it("keeps draft High when unlocked", () => {
    expect(
      resolveEffectiveModelSelection({
        draftModelSelection: draftHigh,
        committedModelSelection: committedLow,
        optionChangeBlocked: false,
      }),
    ).toEqual(draftHigh);
  });

  it("falls back to committed when unlocked and draft is absent", () => {
    expect(
      resolveEffectiveModelSelection({
        draftModelSelection: undefined,
        committedModelSelection: committedLow,
        optionChangeBlocked: false,
      }),
    ).toEqual(committedLow);
  });
});

describe("resolveSessionBoundModelSelectionUpdate", () => {
  const committedLow: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const committedExact: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const normalizedDefault: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const otherModel: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-build",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const handoffCodex: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("applies any selection when the lock is inactive", () => {
    expect(
      resolveSessionBoundModelSelectionUpdate({
        optionChangeBlocked: false,
        committed: committedLow,
        requested: otherModel,
      }),
    ).toEqual({ type: "apply", selection: otherModel });
  });

  it("applies a cross-provider handoff while locked", () => {
    expect(
      resolveSessionBoundModelSelectionUpdate({
        optionChangeBlocked: true,
        committed: committedLow,
        requested: handoffCodex,
      }),
    ).toEqual({ type: "apply", selection: handoffCodex });
  });

  it("rejects a different model on the same committed instance", () => {
    expect(
      resolveSessionBoundModelSelectionUpdate({
        optionChangeBlocked: true,
        committed: committedLow,
        requested: otherModel,
      }),
    ).toEqual({ type: "reject_model_change" });
  });

  it("restores committed selection when reselecting the committed model", () => {
    expect(
      resolveSessionBoundModelSelectionUpdate({
        optionChangeBlocked: true,
        committed: committedLow,
        requested: committedExact,
      }),
    ).toEqual({ type: "restore_committed", selection: committedLow });
  });

  it("restores committed Low when menu normalization supplies default High", () => {
    // Cancels a cross-provider draft and preserves applied effort even though
    // the menu item carried default options rather than the committed ones.
    expect(
      resolveSessionBoundModelSelectionUpdate({
        optionChangeBlocked: true,
        committed: committedLow,
        requested: normalizedDefault,
      }),
    ).toEqual({ type: "restore_committed", selection: committedLow });
  });
});

describe("resolveOutboxModelSelection", () => {
  const grokConfig = {
    providers: [
      {
        instanceId: "grok",
        driver: "grok",
        enabled: true,
        installed: true,
        requiresNewThreadForModelChange: true,
        auth: { status: "authenticated" },
        models: [],
      },
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        requiresNewThreadForModelChange: false,
        auth: { status: "authenticated" },
        models: [],
      },
    ],
  } as unknown as ServerConfig;

  const committedLow: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const queuedStaleHigh: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const queuedHandoff: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  const runtime = { providerInstanceId: "grok" };

  it("pins stale same-instance effort to committed when the session is locked", () => {
    expect(
      resolveOutboxModelSelection({
        config: grokConfig,
        threadHasStarted: true,
        threadRuntime: runtime,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedStaleHigh,
      }),
    ).toEqual(committedLow);
  });

  it("keeps a cross-provider handoff queued selection intact", () => {
    expect(
      resolveOutboxModelSelection({
        config: grokConfig,
        threadHasStarted: true,
        threadRuntime: runtime,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedHandoff,
      }),
    ).toEqual(queuedHandoff);
  });

  it("uses the queued selection when no provider session is active", () => {
    expect(
      resolveOutboxModelSelection({
        config: grokConfig,
        threadHasStarted: false,
        threadRuntime: null,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedStaleHigh,
      }),
    ).toEqual(queuedStaleHigh);
  });
});

describe("resolveOutboxModelSelectionForEnvironment", () => {
  const envA = "env-a";
  const envB = "env-b";
  const lockedGrokConfig = {
    providers: [
      {
        instanceId: "grok",
        driver: "grok",
        enabled: true,
        installed: true,
        requiresNewThreadForModelChange: true,
        auth: { status: "authenticated" },
        models: [],
      },
    ],
  } as unknown as ServerConfig;
  const unlockedGrokConfig = {
    providers: [
      {
        instanceId: "grok",
        driver: "grok",
        enabled: true,
        installed: true,
        requiresNewThreadForModelChange: false,
        auth: { status: "authenticated" },
        models: [],
      },
    ],
  } as unknown as ServerConfig;
  const configsByEnvironment = new Map<string, ServerConfig>([
    [envA, lockedGrokConfig],
    [envB, unlockedGrokConfig],
  ]);
  const committedLow: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const queuedStaleHigh: ModelSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const runtime = { providerInstanceId: "grok" };

  it("normalizes outbox selection using the message environment's lock flag", () => {
    // Message targets envA (locked): pin stale high to committed low.
    expect(
      resolveOutboxModelSelectionForEnvironment({
        serverConfigsByEnvironment: configsByEnvironment,
        environmentId: envA,
        threadHasStarted: true,
        threadRuntime: runtime,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedStaleHigh,
      }),
    ).toEqual(committedLow);

    // Same selection against envB (unlocked) keeps the queued high value.
    expect(
      resolveOutboxModelSelectionForEnvironment({
        serverConfigsByEnvironment: configsByEnvironment,
        environmentId: envB,
        threadHasStarted: true,
        threadRuntime: runtime,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedStaleHigh,
      }),
    ).toEqual(queuedStaleHigh);
  });

  it("defers when the environment config is temporarily missing", () => {
    expect(
      resolveOutboxModelSelectionForEnvironment({
        serverConfigsByEnvironment: configsByEnvironment,
        environmentId: "missing",
        threadHasStarted: true,
        threadRuntime: runtime,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedStaleHigh,
      }),
    ).toBeNull();
  });

  it("does not gate unchanged or cross-instance delivery on a missing config", () => {
    expect(
      resolveOutboxModelSelectionForEnvironment({
        serverConfigsByEnvironment: configsByEnvironment,
        environmentId: "missing",
        threadHasStarted: true,
        threadRuntime: runtime,
        committedModelSelection: committedLow,
        queuedModelSelection: committedLow,
      }),
    ).toEqual(committedLow);

    const queuedHandoff: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    expect(
      resolveOutboxModelSelectionForEnvironment({
        serverConfigsByEnvironment: configsByEnvironment,
        environmentId: "missing",
        threadHasStarted: true,
        threadRuntime: runtime,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedHandoff,
      }),
    ).toEqual(queuedHandoff);

    expect(
      resolveOutboxModelSelectionForEnvironment({
        serverConfigsByEnvironment: configsByEnvironment,
        environmentId: "missing",
        threadHasStarted: false,
        threadRuntime: null,
        committedModelSelection: committedLow,
        queuedModelSelection: queuedStaleHigh,
      }),
    ).toEqual(queuedStaleHigh);
  });
});
