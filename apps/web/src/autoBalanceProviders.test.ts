import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { deriveEffectiveComposerModelState } from "./composerDraftStore";
import {
  autoBalancePickerInstanceId,
  deriveAutoBalanceProviderCatalog,
  environmentSupportsModelSelection,
  isAutoBalanceRoutableEnvironment,
  resolveAutoBalancePickerSelection,
  type AutoBalanceEnvironment,
} from "./autoBalanceProviders";

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const codex = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const key = autoBalancePickerInstanceId(driver, codex);
function model(slug: string, extra: Partial<ServerProviderModel> = {}): ServerProviderModel {
  return { slug, name: slug, isCustom: false, capabilities: {}, ...extra };
}
function provider(extra: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: codex,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-11T00:00:00Z",
    models: [model("model-a")],
    slashCommands: [],
    skills: [],
    ...extra,
  };
}
function environment(
  environmentId: EnvironmentId,
  providers: ServerProvider[],
): AutoBalanceEnvironment {
  return {
    environmentId,
    providers,
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: Object.fromEntries(
        providers.map((p) => [p.instanceId, { driver: p.driver, enabled: true, config: {} }]),
      ),
    },
  };
}
function catalog(environments: AutoBalanceEnvironment[], preferredEnvironmentId = a) {
  return deriveAutoBalanceProviderCatalog({ environments, preferredEnvironmentId });
}
function supports(env: AutoBalanceEnvironment, slug: string, preserveUnavailableModel = false) {
  return environmentSupportsModelSelection({
    ...env,
    instanceId: codex,
    driver,
    model: slug,
    preserveUnavailableModel,
  });
}

describe("automatic machine eligibility", () => {
  it("requires connection and positive weight", () => {
    expect(
      isAutoBalanceRoutableEnvironment({
        connectionPhase: "connected",
        environmentId: a,
        weights: {},
      }),
    ).toBe(true);
    expect(
      isAutoBalanceRoutableEnvironment({
        connectionPhase: "reconnecting",
        environmentId: a,
        weights: {},
      }),
    ).toBe(false);
    expect(
      isAutoBalanceRoutableEnvironment({
        connectionPhase: "connected",
        environmentId: a,
        weights: { [a]: 0 },
      }),
    ).toBe(false);
  });
});

describe("automatic picker catalogue", () => {
  it("handles no eligible environments", () => {
    expect(catalog([]).entries).toEqual([]);
  });

  it("unions model choices while mapping each selection back to a supporting machine", () => {
    const union = catalog([
      environment(a, [provider()]),
      environment(b, [provider({ models: [model("model-b")] })]),
    ]);
    expect(union.modelOptionsByInstance.get(key)?.map((m) => m.slug)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(resolveAutoBalancePickerSelection(union, key, "model-b")).toMatchObject({
      environmentId: b,
      instanceId: codex,
    });
    expect(resolveAutoBalancePickerSelection(union, key, "missing")).toBeNull();
  });

  it.each([
    ["disabled probe", { enabled: false }],
    ["uninstalled", { installed: false }],
    ["error", { status: "error" }],
    ["unauthenticated", { auth: { status: "unauthenticated" } }],
    ["unavailable", { availability: "unavailable" }],
  ] as const)("excludes models from a %s snapshot", (_label, extra) => {
    const union = catalog([
      environment(a, [provider()]),
      environment(b, [provider({ ...extra, models: [model("bad-model")] })]),
    ]);
    expect(union.modelOptionsByInstance.get(key)?.map((m) => m.slug)).toEqual(["model-a"]);
    expect(resolveAutoBalancePickerSelection(union, key, "bad-model")).toBeNull();
  });

  it("honors settings disabling a provider before the next probe", () => {
    const remote = environment(b, [provider({ models: [model("model-b")] })]);
    remote.settings = {
      ...remote.settings,
      providerInstances: { [codex]: { driver, enabled: false, config: {} } },
    };
    expect(
      catalog([environment(a, [provider()]), remote])
        .modelOptionsByInstance.get(key)
        ?.map((m) => m.slug),
    ).toEqual(["model-a"]);
    expect(supports(remote, "model-b")).toBe(false);
  });

  it("shows a remote-only custom instance using its owning settings", () => {
    const instanceId = ProviderInstanceId.make("remote-work");
    const remote = environment(b, [provider({ instanceId })]);
    remote.settings = {
      ...remote.settings,
      providerInstances: {
        [instanceId]: {
          driver,
          config: { customModels: [{ slug: "custom-remote", name: "Remote model" }] },
        },
      },
    };
    const union = catalog([environment(a, []), remote]);
    const remoteKey = autoBalancePickerInstanceId(driver, instanceId);
    expect(union.entries[0]).toMatchObject({ enabled: true, instanceId: remoteKey });
    expect(union.modelOptionsByInstance.get(remoteKey)).toContainEqual(
      expect.objectContaining({ slug: "custom-remote", name: "Remote model" }),
    );
    expect(resolveAutoBalancePickerSelection(union, remoteKey, "custom-remote")).toMatchObject({
      environmentId: b,
      instanceId,
    });
  });

  it("keeps identical instance names on different drivers distinct", () => {
    const instanceId = ProviderInstanceId.make("work");
    const claude = ProviderDriverKind.make("claudeAgent");
    const union = catalog([
      environment(a, [provider({ instanceId })]),
      environment(b, [provider({ instanceId, driver: claude, models: [model("claude-model")] })]),
    ]);
    expect(new Set(union.entries.map((e) => e.instanceId)).size).toBe(2);
    expect(
      resolveAutoBalancePickerSelection(
        union,
        autoBalancePickerInstanceId(claude, instanceId),
        "claude-model",
      ),
    ).toMatchObject({ environmentId: b, instanceId, driver: claude });
    expect(
      union.modelOptionsByInstance
        .get(autoBalancePickerInstanceId(driver, instanceId))
        ?.map((m) => m.slug),
    ).toEqual(["model-a"]);
  });

  it("takes duplicate model labels from the routed machine without mutating its snapshot", () => {
    const primary = environment(a, [provider()]);
    const remote = environment(b, [
      provider({ models: [model("model-a", { name: "Remote label" })] }),
    ]);
    const union = catalog([primary, remote], b);
    expect(union.modelOptionsByInstance.get(key)?.[0]?.name).toBe("Remote label");
    expect(remote.providers[0]?.instanceId).toBe(codex);
    expect(primary.providers[0]?.models[0]?.name).toBe("model-a");
  });

  it("keeps attachment-bound choices on the pinned machine", () => {
    const pinned = environment(a, [provider()]);
    const remote = environment(b, [provider({ models: [model("model-b")] })]);
    const union = deriveAutoBalanceProviderCatalog({
      environments: [pinned, remote],
      attachmentEnvironmentId: a,
    });
    expect(resolveAutoBalancePickerSelection(union, key, "model-b")).toBeNull();
    expect(resolveAutoBalancePickerSelection(union, key, "model-a")?.environmentId).toBe(a);
  });
});

describe("routing the effective selection", () => {
  it("matches model aliases and rejects missing models", () => {
    const env = environment(a, [provider({ models: [model("model-a", { aliases: ["latest"] })] })]);
    expect(supports(env, "latest")).toBe(true);
    expect(supports(env, "model-b")).toBe(false);
  });

  it("routes custom models present in settings before they appear in the probe", () => {
    const env = environment(a, [provider()]);
    env.settings = {
      ...env.settings,
      providerInstances: { [codex]: { driver, config: { customModels: ["custom-model"] } } },
    };
    expect(supports(env, "custom-model")).toBe(true);
  });

  it("checks inherited defaults rather than skipping the model with an empty draft", () => {
    const env = environment(a, [provider({ models: [model("model-a"), model("model-b")] })]);
    const effective = deriveEffectiveComposerModelState({
      draft: null,
      providers: env.providers,
      selectedProvider: driver,
      selectedInstanceId: codex,
      threadModelSelection: null,
      projectModelSelection: { instanceId: codex, model: "model-b" },
      settings: env.settings,
    });
    expect(effective.selectedModel).toBe("model-b");
    expect(supports(environment(b, [provider()]), effective.selectedModel)).toBe(false);
  });

  it("routes the visible fallback when a saved model is hidden", () => {
    const env = environment(a, [provider({ models: [model("model-a"), model("model-b")] })]);
    env.settings = {
      ...env.settings,
      providerModelPreferences: { [codex]: { hiddenModels: ["model-a"], modelOrder: [] } },
    };
    const effective = deriveEffectiveComposerModelState({
      draft: {
        activeProvider: codex,
        modelSelectionByProvider: { [codex]: { instanceId: codex, model: "model-a" } },
      },
      providers: env.providers,
      selectedProvider: driver,
      selectedInstanceId: codex,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: env.settings,
    });
    expect(effective.selectedModel).toBe("model-b");
    expect(supports(environment(b, [provider()]), effective.selectedModel)).toBe(false);
  });

  it.each(["opencode", "antigravity"])(
    "preserves a missing %s selection only on its owning machine",
    (kind) => {
      const dynamicDriver = ProviderDriverKind.make(kind);
      const instanceId = ProviderInstanceId.make(kind);
      const env = environment(a, [provider({ driver: dynamicDriver, instanceId, models: [] })]);
      const input = { ...env, driver: dynamicDriver, instanceId, model: "missing-dynamic" };
      expect(environmentSupportsModelSelection(input)).toBe(false);
      expect(environmentSupportsModelSelection({ ...input, preserveUnavailableModel: true })).toBe(
        true,
      );
    },
  );
});

describe("dynamic catalogue recovery", () => {
  it("retains an unavailable selected model only on its current machine", () => {
    const kind = ProviderDriverKind.make("opencode");
    const instanceId = ProviderInstanceId.make("opencode");
    const union = deriveAutoBalanceProviderCatalog({
      environments: [environment(a, [provider({ driver: kind, instanceId, models: [] })])],
      preferredEnvironmentId: a,
      currentSelection: { driver: kind, instanceId, model: "missing-model" },
    });
    const pickerId = autoBalancePickerInstanceId(kind, instanceId);
    expect(union.modelOptionsByInstance.get(pickerId)).toContainEqual(
      expect.objectContaining({ slug: "missing-model", isUnavailable: true }),
    );
    expect(resolveAutoBalancePickerSelection(union, pickerId, "missing-model")?.environmentId).toBe(
      a,
    );
  });

  it("prefers an advertised remote model over a local unavailable placeholder", () => {
    const kind = ProviderDriverKind.make("opencode");
    const instanceId = ProviderInstanceId.make("opencode");
    const union = deriveAutoBalanceProviderCatalog({
      environments: [
        environment(a, [provider({ driver: kind, instanceId, models: [] })]),
        environment(b, [provider({ driver: kind, instanceId, models: [model("recovered")] })]),
      ],
      preferredEnvironmentId: a,
      currentSelection: { driver: kind, instanceId, model: "recovered" },
    });
    const pickerId = autoBalancePickerInstanceId(kind, instanceId);
    expect(union.modelOptionsByInstance.get(pickerId)?.[0]?.isUnavailable).not.toBe(true);
    expect(resolveAutoBalancePickerSelection(union, pickerId, "recovered")?.environmentId).toBe(b);
  });
});
