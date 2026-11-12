import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  buildModelOptions,
  describeUnavailableModelSelection,
  groupByProvider,
  isModelSelectionUnavailable,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
  type ModelOption,
} from "./modelOptions";




describe("mobile model options", () => {
  it("distinguishes same-name OpenCode models without changing their routing", () => {
    const sources = [
      { id: "anthropic", label: "Anthropic" },
      { id: "github-copilot", label: "GitHub Copilot" },
      { id: "opencode", label: "OpenCode Zen" },
    ];
    const config = {
      providers: [
        {
          instanceId: "opencode_work",
          driver: "opencode",
          displayName: "OpenCode Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: sources.map((source) => ({
            slug: `${source.id}/claude-fable-5`,
            name: "Claude Fable 5",
            subProvider: source.label,
            isCustom: false,
            capabilities: null,
          })),
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("opencode_work"),
      model: "github-copilot/claude-fable-5",
    };

    const options = buildModelOptions(config, selection, undefined, null);

    expect(options).toMatchObject(
      sources.map((source) => ({
        key: `opencode_work:${source.id}/claude-fable-5`,
        label: "Claude Fable 5",
        subtitle: source.label,
        providerLabel: "OpenCode Work",
        selection: {
          instanceId: "opencode_work",
          model: `${source.id}/claude-fable-5`,
        },
      })),
    );
    expect(groupByProvider(options)).toEqual([
      { providerKey: "opencode_work", providerLabel: "OpenCode Work", models: options },
    ]);
  });
  it("does not materialize catalog defaults for missing stored options", () => {
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

    const [option] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
      },
      undefined,
      null,
    );

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toBeUndefined();

    const [emptyOption] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
        options: [],
      },
      undefined,
      null,
    );
    expect(emptyOption?.selection).toEqual(option?.selection);

    const [explicitOption] = buildModelOptions(
      config,
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
        options: [{ id: "serviceTier", value: "priority" }],
      },
      undefined,
      null,
    );
    expect(explicitOption?.selection.options).toEqual([{ id: "serviceTier", value: "priority" }]);
  });
  it("limits existing threads to their provider while new tasks keep every provider", () => {
    const providers = ["codex", "claudeAgent"].map((instanceId) => ({
      instanceId,
      driver: instanceId,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: "test", name: instanceId, capabilities: null }],
    }));
    const config = { providers } as unknown as ServerConfig;
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };

    expect(
      buildModelOptions(config, selection, undefined, null).map((option) => option.providerKey),
    ).toEqual(["codex", "claudeAgent"]);
    expect(buildModelOptions(config, selection, selection.instanceId, null)).toEqual(
      buildModelOptions(config, selection, undefined, null).filter(
        (option) => option.providerKey === "codex",
      ),
    );
  });
  it("keeps accounts in the continuation group and excludes other providers", () => {
    const config = {
      providers: [
        { instanceId: "codex", driver: "codex", continuation: { groupKey: "shared" } },
        { instanceId: "codex_work", driver: "codex", continuation: { groupKey: "shared" } },
        { instanceId: "codex_other", driver: "codex", continuation: { groupKey: "other" } },
        { instanceId: "claude", driver: "claudeAgent", continuation: { groupKey: "shared" } },
      ].map((provider) => ({
        ...provider,
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "test", name: "Test", capabilities: null }],
      })),
    } as unknown as ServerConfig;
    expect(
      buildModelOptions(config, null, ProviderInstanceId.make("codex"), null).map(
        (option) => option.providerKey,
      ),
    ).toEqual(["codex", "codex_work"]);
  });
  it("matches the web driver fallback without moving unknown Antigravity history", () => {
    const config = {
      providers: [
        { instanceId: "codex", driver: "codex" },
        { instanceId: "codex_work", driver: "codex" },
        { instanceId: "google", driver: "antigravity" },
        { instanceId: "google_work", driver: "antigravity" },
      ].map((provider) => ({
        ...provider,
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "test", name: "Test", capabilities: null }],
      })),
    } as unknown as ServerConfig;
    expect(
      buildModelOptions(config, null, ProviderInstanceId.make("codex"), null).map(
        (option) => option.providerKey,
      ),
    ).toEqual(["codex", "codex_work"]);
    expect(
      buildModelOptions(config, null, ProviderInstanceId.make("google"), null).map(
        (option) => option.providerKey,
      ),
    ).toEqual(["google"]);
  });
  it("carries account badges into catalog and saved fallback models", () => {
    const config = {
      providers: [
        { instanceId: "codex", driver: "codex", displayName: "Personal" },
        { instanceId: "codex_work", driver: "codex", displayName: "Work", accentColor: "#123456" },
      ].map((provider) => ({
        ...provider,
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "test", name: "Test", capabilities: null }],
      })),
    } as unknown as ServerConfig;
    const selection = { instanceId: ProviderInstanceId.make("codex_work"), model: "saved" };
    const options = buildModelOptions(config, selection, undefined, null);
    expect(options[0]?.providerBadge).toEqual({ displayName: "Personal", showBadge: true });
    expect(options[1]?.providerBadge).toEqual({
      displayName: "Work",
      accentColor: "#123456",
      showBadge: true,
    });
    expect(options[2]?.providerBadge).toEqual(options[1]?.providerBadge);
    expect(
      buildModelOptions(
        { ...config, providers: config.providers.slice(0, 1) },
        null,
        undefined,
        null,
      )[0]?.providerBadge?.showBadge,
    ).toBe(false);
  });
  it("only badges ACP accounts that share the same agent", () => {
    const config = {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          acp_one: { driver: "acpRegistry", enabled: true, config: { agentId: "one" } },
          acp_two: { driver: "acpRegistry", enabled: true, config: { agentId: "two" } },
        },
      },
      providers: ["acp_one", "acp_two"].map((instanceId) => ({
        instanceId,
        driver: "acpRegistry",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "test", name: "Test", capabilities: null }],
      })),
    } as unknown as ServerConfig;
    expect(
      buildModelOptions(config, null, undefined, null).map(
        (option) => option.providerBadge?.showBadge,
      ),
    ).toEqual([false, false]);
    const shared = {
      ...config,
      settings: {
        ...config.settings,
        providerInstances: {
          ...config.settings.providerInstances,
          acp_two: config.settings.providerInstances[ProviderInstanceId.make("acp_one")]!,
        },
      },
    };
    expect(
      buildModelOptions(shared, null, undefined, null).map(
        (option) => option.providerBadge?.showBadge,
      ),
    ).toEqual([true, true]);
  });
  it.each(["disabled", "unavailable", "missing"] as const)(
    "retains the selected %s provider's fallback in a filtered catalog",
    (state) => {
      const selection = {
        instanceId: ProviderInstanceId.make("google_work"),
        model: "saved-model",
        options: [{ id: "native-option", value: "saved-choice" }],
      };
      const provider = {
        instanceId: selection.instanceId,
        driver: "antigravity",
        displayName: "Google Work",
        enabled: state !== "disabled",
        installed: true,
        availability: state === "unavailable" ? "unavailable" : "available",
        auth: { status: "authenticated" },
        models: [{ slug: selection.model, name: "Saved model", capabilities: null }],
      };
      const config = {
        providers: state === "missing" ? [] : [provider],
        settings: { providerInstances: { google_work: { driver: "antigravity" } } },
      } as unknown as ServerConfig;
      const options = buildModelOptions(config, selection, selection.instanceId, null);
      expect(options).toEqual(buildModelOptions(config, selection, undefined, null));
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection, isUnavailable: true });
    },
  );
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

    expect(resolveSelectableModelSelection(config, usable, null)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled, null)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed, null)).toBeNull();
    expect(isModelSelectionUnavailable(config, disabled, null)).toBe(true);
    expect(isModelSelectionUnavailable(config, removed, null)).toBe(false);
    expect(resolveSelectableModelSelection(null, disabled, null)).toBe(disabled);
  });
  describe("Antigravity selections", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("google_work"),
      model: "gemini-3.1-pro-high",
      options: [{ id: "native-option", value: "saved/opaque-choice" }],
    };
    const model = {
      slug: selection.model,
      name: "Gemini 3.1 Pro High",
      subProvider: "Google",
      isCustom: false,
      isDefault: true,
      isLegacy: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "native-option",
            label: "Native option",
            type: "select",
            options: [{ id: "current/default", label: "Default", isDefault: true }],
            currentValue: "current/default",
          },
        ],
      },
    };
    const config = {
      providers: [
        {
          instanceId: selection.instanceId,
          driver: "antigravity",
          displayName: "Google Work",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [model],
        },
      ],
    } as unknown as ServerConfig;

    it.each([
      ["disabled", { enabled: false }],
      ["signed out", { auth: { status: "unauthenticated" } }],
    ] as const)("keeps a %s provider's selection and known model details", (_state, update) => {
      const unavailableConfig = {
        ...config,
        providers: config.providers.map((provider) => ({ ...provider, ...update })),
      };

      expect(resolveSelectableModelSelection(unavailableConfig, selection, null)).toBe(selection);
      expect(resolveDefaultableModelSelection(unavailableConfig, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(unavailableConfig, selection, null)).toBe(true);
      expect(buildModelOptions(unavailableConfig, null, undefined, null)).toEqual([]);
      const [option] = buildModelOptions(unavailableConfig, selection, undefined, null);
      expect(option).toMatchObject({
        key: `google_work:${selection.model}`,
        label: model.name,
        subtitle: "Google",
        providerKey: "google_work",
        providerLabel: "Google Work",
        providerDriver: "antigravity",
        isDefault: false,
        isLegacy: true,
        isUnavailable: true,
        capabilities: model.capabilities,
      });
      expect(option?.selection).toBe(selection);
    });

    it("keeps an exact selection when its model leaves and returns to the catalog", () => {
      const changedConfig = {
        ...config,
        providers: config.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model, slug: "gemini-3.1-pro-low" })),
        })),
      };

      expect(resolveDefaultableModelSelection(changedConfig, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(changedConfig, selection, null)).toBe(true);
      const options = buildModelOptions(changedConfig, selection, undefined, null);
      const missing = options.find((option) => option.selection.model === selection.model);
      expect(missing).toMatchObject({
        label: selection.model,
        providerLabel: "Google Work",
        providerDriver: "antigravity",
        isUnavailable: true,
        capabilities: null,
      });
      expect(missing?.selection).toBe(selection);
      expect(
        resolveNewTaskModelSelection({
          draftSelection: null,
          projectDefaultSelection: resolveDefaultableModelSelection(changedConfig, selection, null),
          stickySelection: null,
          modelOptions: options,
        }),
      ).toBe(selection);

      const [restored] = buildModelOptions(config, selection, undefined, null);
      expect(isModelSelectionUnavailable(config, selection, null)).toBe(false);
      expect(restored?.isUnavailable).not.toBe(true);
      expect(restored?.selection).toBe(selection);
      expect(resolveDefaultableModelSelection(config, selection, null)).toBe(selection);
      expect(
        buildModelOptions(config, null, undefined, null)[0]?.selection.options,
      ).toBeUndefined();
    });

    it("uses configured instance metadata when provider status is missing", () => {
      const missingStatusConfig = {
        providers: [],
        settings: {
          providerInstances: {
            [selection.instanceId]: { driver: "antigravity", displayName: "Google Work" },
          },
        },
      } as unknown as ServerConfig;

      expect(resolveDefaultableModelSelection(missingStatusConfig, selection, null)).toBe(
        selection,
      );
      expect(isModelSelectionUnavailable(missingStatusConfig, selection, null)).toBe(true);
      expect(buildModelOptions(missingStatusConfig, selection, undefined, null)).toMatchObject([
        {
          providerDriver: "antigravity",
          providerLabel: "Google Work",
          isUnavailable: true,
          selection,
        },
      ]);
    });

    it("keeps offline selections without assuming that an unknown instance is Antigravity", () => {
      const unknownConfig = { ...config, providers: [] };

      expect(resolveDefaultableModelSelection(null, selection, null)).toBe(selection);
      expect(isModelSelectionUnavailable(null, selection, null)).toBe(false);
      expect(buildModelOptions(null, selection, undefined, null)[0]?.selection).toBe(selection);
      expect(buildModelOptions(null, selection, undefined, null)[0]?.isUnavailable).not.toBe(true);
      expect(isModelSelectionUnavailable(unknownConfig, selection, null)).toBe(false);
      expect(resolveSelectableModelSelection(unknownConfig, selection, null)).toBeNull();
    });
  });
  it("keeps legacy models out of implicit defaults", () => {
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
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
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

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current, null)).toBe(current);
    expect(resolveDefaultableModelSelection(config, legacy, null)).toBeNull();
    expect(resolveDefaultableModelSelection(null, legacy, null)).toBe(legacy);
  });
  it("resolves new tasks from draft, project, sticky, then provider defaults", () => {
    const draft = { instanceId: ProviderInstanceId.make("codex"), model: "draft" };
    const project = { instanceId: ProviderInstanceId.make("codex"), model: "project" };
    const sticky = { instanceId: ProviderInstanceId.make("codex"), model: "sticky" };
    const providerDefault = {
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
      isDefault: true,
    } as ModelOption;
    const resolve = (
      draftSelection: ModelSelection | null,
      projectDefaultSelection: ModelSelection | null,
      stickySelection: ModelSelection | null,
    ) =>
      resolveNewTaskModelSelection({
        draftSelection,
        projectDefaultSelection,
        stickySelection,
        modelOptions: [providerDefault],
      });

    expect(resolve(draft, project, sticky)).toBe(draft);
    expect(resolve(null, project, sticky)).toBe(project);
    expect(resolve(null, null, sticky)).toBe(sticky);
    expect(resolve(null, null, null)).toBe(providerDefault.selection);

    const unavailable = { ...providerDefault, isUnavailable: true };
    expect(
      resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: null,
        modelOptions: [unavailable],
      }),
    ).toBeNull();
  });
});

