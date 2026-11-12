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




describe("synchronized mobile model visibility", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const other = ProviderInstanceId.make("codex_personal");
  const models = [
    { slug: "hidden", name: "Hidden", isCustom: false, capabilities: null },
    { slug: "first", name: "First", isCustom: false, capabilities: null },
    { slug: "second", name: "Second", isCustom: false, capabilities: null },
    { slug: "custom", name: "Custom", isCustom: true, capabilities: null },
  ];
  const config = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [provider]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        [other]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      providerModelPreferences: {
        [provider]: {
          hiddenModels: ["hidden", "custom", "missing"],
          modelOrder: ["second", "first"],
        },
      },
    },
    providers: [provider, other].map((instanceId) => ({
      instanceId,
      continuation: { groupKey: instanceId },
      driver: "codex",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models,
    })),
  } as unknown as ServerConfig;

  it("applies server visibility and ordering independently to each provider instance", () => {
    const options = buildModelOptions(config, null, undefined, null);
    expect(
      options
        .filter((option) => option.providerKey === provider)
        .map((option) => option.selection.model),
    ).toEqual(["second", "first", "custom"]);
    expect(
      options
        .filter((option) => option.providerKey === other)
        .map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  it("exposes hidden built-ins for management without offering custom visibility controls", () => {
    const options = buildModelOptions(
      config,
      { instanceId: provider, model: "hidden" },
      provider,
      null,
      true,
    );
    expect(options.map((option) => option.selection.model)).toEqual([
      "second",
      "first",
      "hidden",
      "custom",
    ]);
    expect(options.find((option) => option.selection.model === "hidden")).toMatchObject({
      isHidden: true,
      canHide: true,
    });
    expect(options.find((option) => option.selection.model === "custom")).toMatchObject({
      isHidden: false,
      canHide: false,
    });
  });

  it.each(["hidden", "missing"])("does not resurrect the hidden fallback %s", (model) => {
    expect(
      buildModelOptions(config, { instanceId: provider, model }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toEqual(["second", "first", "custom"]);
  });

  // regression: #16816 sync model favorites and visibility across clients
  it("keeps custom models visible and restores built-in models when the server clears hidden models", () => {
    expect(
      buildModelOptions(config, { instanceId: provider, model: "custom" }, provider, null).map(
        (option) => option.selection.model,
      ),
    ).toContain("custom");
    const cleared = { ...config, settings: { ...config.settings, providerModelPreferences: {} } };
    expect(
      buildModelOptions(cleared, null, provider, null).map((option) => option.selection.model),
    ).toEqual(["hidden", "first", "second", "custom"]);
  });

  describe("managed provider policy", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5.6-sol", name: "GPT", isCustom: false, capabilities: null }],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "claude-sonnet-5", name: "Sonnet", isCustom: false, capabilities: null },
          ],
        },
      ],
      managedPolicy: {
        organization: "Example Corp",
        lockedSettings: [],
        limits: { providers: { allowedDrivers: [ProviderDriverKind.make("codex")] } },
      },
    } as unknown as ServerConfig;
    const disallowed = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };

    it("leaves drivers the policy does not allow out of the picker", () => {
      expect(
        buildModelOptions(config, null, undefined, null).map((option) => option.providerKey),
      ).toEqual(["codex"]);
    });

    it("marks a thread's selection on a disallowed driver unavailable with the policy reason", () => {
      expect(
        buildModelOptions(config, disallowed, undefined, null).find(
          (option) => option.providerKey === "claudeAgent",
        )?.isUnavailable,
      ).toBe(true);
      expect(isModelSelectionUnavailable(config, disallowed, null)).toBe(true);
      expect(describeUnavailableModelSelection(config, disallowed, null)).toEqual({
        title: "Provider not allowed",
        detail: "Example Corp's policy does not allow the Claude provider. Choose another model.",
      });
    });
  });
});

