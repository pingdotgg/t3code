import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AcpRegistryOperationError,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { toCustomModelSetting } from "@t3tools/shared/model";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  AcpRegistryDriver,
  MAX_DISPLACED_LEARNED_MODELS,
  acpRegistryProbeSupersedesLiveCatalog,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
  isAcpRegistryCacheValid,
  retainAcpRegistryLiveOptionsAfterProbe,
  updateAcpRegistryEnrichmentCache,
  updateAcpRegistryLearnedModelsFromLive,
  updateAcpRegistryLearnedModelsFromProbe,
} from "./driver.ts";
import {
  ACP_REGISTRY_MAX_MODELS,
  type AcpRegistryLiveConfiguration,
  acpRegistryAdvertisesModelCatalog,
  acpRegistryProbeResult,
  normalizeAcpRegistryLiveConfiguration,
  prepareAcpRegistryLiveConfiguration,
} from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

function providerWithModels(
  models: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
  }>,
  currentModelId: string | null,
): ReturnType<typeof buildCheckedAcpRegistrySnapshot> {
  return buildCheckedAcpRegistrySnapshot({
    ...identity,
    settings: decodeSettings({ agentId: "test-agent" }),
    checkedAt: "2026-08-13T10:00:00.000Z",
    inspection: {
      status: "ready",
      agentId: "test-agent",
      version: "1.0.0",
      distribution: "npx",
    },
    probe: {
      probe: {
        instanceId: identity.instanceId,
        ready: true,
        icon: null,
        authMethods: [],
        models,
        currentModelId,
        configOptions: [],
        sessionManagement: noSessionManagement,
      },
      slashCommands: [],
      skills: [],
    },
  });
}

describe("acpRegistrySnapshotReadiness", () => {
  it("keeps the custom model display name and options saved by the Settings editor", () => {
    const fastMode = { id: "fast", label: "Fast mode", type: "boolean" } as const;
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [
          toCustomModelSetting({
            slug: "gateway/my-model",
            name: "My model",
            capabilities: { optionDescriptors: [fastMode] },
          }),
        ],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
    });
    const model = snapshot.models.find((entry) => entry.slug === "gateway/my-model");
    expect(model?.name).toBe("My model");
    expect(model?.capabilities?.optionDescriptors).toEqual([fastMode]);
  });

  it("shows the version reported by a local ACP agent", () => {
    const probe = acpRegistryProbeResult(identity.instanceId, {
      sessionId: "test-session",
      initializeResult: {
        protocolVersion: 1,
        agentInfo: { name: "Example agent", version: "1.5.9" },
      },
      sessionSetupResult: {},
      modelConfigId: undefined,
    });
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ source: "local", commandPath: "example" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "example", version: null, distribution: "local" },
      probe: { probe, slashCommands: [], skills: [] },
    });
    expect(snapshot.version).toBe("1.5.9");
    const withoutVersion = acpRegistryProbeResult(identity.instanceId, {
      sessionId: "test-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {},
      modelConfigId: undefined,
    });
    expect(
      buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({ source: "local", commandPath: "example" }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: { status: "ready", agentId: "example", version: null, distribution: "local" },
        probe: { probe: withoutVersion, slashCommands: [], skills: [] },
      }).version,
    ).toBeNull();
  });

  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [], modelsFromModelSelect: false },
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
          modelsFromModelSelect: false,
        },
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: [], modelsFromModelSelect: false },
        [],
      ).models,
    ).toEqual(provider.models);

    const liveOptions = [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [{ id: "high", label: "High" }],
        currentValue: "high",
      },
    ];
    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [],
          currentModelId: null,
          configOptions: liveOptions,
          modelsFromModelSelect: false,
        },
        [],
      ).models,
    ).toMatchObject([
      {
        slug: "probe-model",
        isDefault: true,
        capabilities: { optionDescriptors: [{ id: "effort", currentValue: "high" }] },
      },
    ]);

    // Session configOptions describe the current model only.
    const sharedMode = {
      id: "mode",
      label: "Mode",
      type: "select" as const,
      options: [{ id: "ask", label: "Ask" }],
      currentValue: "ask",
    };
    const twoModelList = [
      { id: "glm", name: "GLM", description: null },
      { id: "opus", name: "Opus", description: null },
    ];
    const afterGlm = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: twoModelList,
        currentModelId: "glm",
        configOptions: [...liveOptions, sharedMode],
        modelOptionIds: ["effort"],
      },
      [],
    );
    const twoModels = afterGlm.models;
    expect(twoModels.find((model) => model.slug === "glm")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "effort" }, { id: "mode" }] },
    });
    expect(
      twoModels.find((model) => model.slug === "opus")?.capabilities?.optionDescriptors ?? [],
    ).toEqual([sharedMode]);
    // A later session on another model keeps the options learned for this one.
    const afterOpus = applyAcpRegistryLiveConfiguration(
      afterGlm,
      {
        models: twoModelList,
        currentModelId: "opus",
        configOptions: [{ ...liveOptions[0]!, id: "thinking" }, sharedMode],
        modelOptionIds: ["thinking"],
      },
      [],
    ).models;
    expect(afterOpus.find((model) => model.slug === "glm")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "mode" }, { id: "effort" }] },
    });
    expect(afterOpus.find((model) => model.slug === "opus")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "thinking" }, { id: "mode" }] },
    });

    // Other models take the levels they advertise in `_meta`.
    const effort = {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select" as const,
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    };
    const advertised = applyAcpRegistryLiveConfiguration(
      provider,
      normalizeAcpRegistryLiveConfiguration([effort], undefined, {
        currentModelId: "opus",
        availableModels: [
          { modelId: "opus", name: "Opus" },
          {
            modelId: "haiku",
            name: "Haiku",
            _meta: { reasoningEfforts: [{ value: "low", label: "Low" }], reasoningEffort: "low" },
          },
          { modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } },
        ],
      }),
      [],
    ).models.map((model) => model.capabilities?.optionDescriptors ?? []);
    expect(advertised).toEqual([
      [{ ...liveOptions[0]!, role: "reasoning" }],
      [
        {
          ...liveOptions[0]!,
          role: "reasoning",
          options: [{ id: "low", label: "Low" }],
          currentValue: "low",
        },
      ],
      [],
    ]);

    // An explicit supportsReasoningEffort: false on the current model strips the session effort selector too.
    const currentDisabled = applyAcpRegistryLiveConfiguration(
      provider,
      normalizeAcpRegistryLiveConfiguration([effort], undefined, {
        currentModelId: "glm",
        availableModels: [
          { modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } },
          { modelId: "opus", name: "Opus" },
        ],
      }),
      [],
    ).models.map((model) => model.capabilities?.optionDescriptors ?? []);
    expect(currentDisabled).toEqual([[], []]);

    // supportsReasoningEffort: false marks reasoning disabled even without an effort selector,
    // and strips current-model reasoning consistently regardless of includeCatalog.
    const disabledWithoutSelector = normalizeAcpRegistryLiveConfiguration([], undefined, {
      currentModelId: "glm",
      availableModels: [{ modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } }],
    });
    expect(disabledWithoutSelector.models).toEqual([
      { id: "glm", name: "GLM", description: null, reasoningEffort: null },
    ]);

    const preparedDisabled = prepareAcpRegistryLiveConfiguration([effort], undefined, {
      currentModelId: "glm",
      availableModels: [
        { modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } },
        { modelId: "opus", name: "Opus" },
      ],
    });
    const catalogDisabled = preparedDisabled.toLiveConfiguration({ includeCatalog: true });
    const optionsOnlyDisabled = preparedDisabled.toLiveConfiguration({ includeCatalog: false });
    expect(catalogDisabled.configOptions).toEqual([]);
    expect(optionsOnlyDisabled.configOptions).toEqual(catalogDisabled.configOptions);
    expect(optionsOnlyDisabled.modelOptionIds).toEqual([]);
    const providerAfterCatalogDisable = applyAcpRegistryLiveConfiguration(
      provider,
      catalogDisabled,
      [],
    );
    expect(
      applyAcpRegistryLiveConfiguration(
        providerAfterCatalogDisable,
        optionsOnlyDisabled,
        [],
      ).models.map((model) => model.capabilities?.optionDescriptors ?? []),
    ).toEqual([[], []]);

    // An options-only update from an older session whose frozen _meta had supportsReasoningEffort: false
    // for a non-current model must not undo reasoning that a newer probe re-enabled on that model.
    const probeReenabledGlm = applyAcpRegistryLiveConfiguration(
      provider,
      normalizeAcpRegistryLiveConfiguration([effort], undefined, {
        currentModelId: "glm",
        availableModels: [
          { modelId: "glm", name: "GLM" },
          { modelId: "opus", name: "Opus" },
        ],
      }),
      [],
    );
    const staleSessionOptionsOnOpus = prepareAcpRegistryLiveConfiguration([effort], undefined, {
      currentModelId: "opus",
      availableModels: [
        { modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } },
        { modelId: "opus", name: "Opus" },
      ],
    }).toLiveConfiguration({ includeCatalog: false });
    expect(
      applyAcpRegistryLiveConfiguration(
        probeReenabledGlm,
        staleSessionOptionsOnOpus,
        [],
      ).models.map((model) =>
        (model.capabilities?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
      ),
    ).toEqual([["effort"], ["effort"]]);

    // Explicit probe-level reasoningDisabledModelSlugs keeps effort off a disabled model during
    // an options-only overlay while preserving unrelated options and allowing enabled models.
    const modeDescriptor = {
      id: "mode",
      label: "Mode",
      type: "select" as const,
      currentValue: "plan",
      options: [
        { id: "code", label: "Code" },
        { id: "plan", label: "Plan" },
      ],
    };
    const effortDescriptor = { ...liveOptions[0]!, role: "reasoning" as const };
    const overlaidDisabled = applyAcpRegistryLiveConfiguration(
      providerWithModels(
        [
          { id: "glm", name: "GLM", description: null },
          { id: "opus", name: "Opus", description: null },
        ],
        "glm",
      ),
      {
        models: [],
        currentModelId: "glm",
        configOptions: [modeDescriptor, effortDescriptor],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
      },
      [],
      undefined,
      { reasoningDisabledModelSlugs: new Set(["glm"]) },
    );
    expect(
      overlaidDisabled.models.map((model) =>
        (model.capabilities?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
      ),
    ).toEqual([["mode"], ["mode"]]);
    const overlaidEnabled = applyAcpRegistryLiveConfiguration(
      overlaidDisabled,
      {
        models: [],
        currentModelId: "opus",
        configOptions: [modeDescriptor, effortDescriptor],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
      },
      [],
      undefined,
      { reasoningDisabledModelSlugs: new Set(["glm"]) },
    );
    expect(
      overlaidEnabled.models.map((model) =>
        (model.capabilities?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
      ),
    ).toEqual([["mode"], ["mode", "effort"]]);

    // Live reasoning-only replay (orphaned advertisedReasoning) preserves shared options on all
    // models even when previousModels only holds learned model-specific options.
    const lowOnlyEffort = {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      role: "reasoning" as const,
      options: [{ id: "low", label: "Low" }],
      currentValue: "low",
    };
    const withNarrowOpus = applyAcpRegistryLiveConfiguration(
      overlaidEnabled,
      {
        models: [
          { id: "glm", name: "GLM", description: null },
          { id: "opus", name: "Opus", description: null, reasoningEffort: lowOnlyEffort },
        ],
        currentModelId: "glm",
        configOptions: [modeDescriptor],
        modelsFromModelSelect: true,
      },
      [],
    );
    const afterOrphanOverlay = applyAcpRegistryLiveConfiguration(
      withNarrowOpus,
      {
        models: [],
        currentModelId: null,
        configOptions: [],
        advertisedReasoning: { opus: effortDescriptor },
        preserveDefault: true,
      },
      [],
      [],
    );
    expect(afterOrphanOverlay.models.find((m) => m.slug === "glm")?.isDefault).toBe(true);
    expect(
      afterOrphanOverlay.models.map((model) =>
        (model.capabilities?.optionDescriptors ?? []).map((d) => [d.id, d.currentValue]),
      ),
    ).toEqual([
      [["mode", "plan"]],
      [
        ["mode", "plan"],
        ["effort", "high"],
      ],
    ]);
  });

  it("keeps each Mistral Vibe model's own thinking levels", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "mistral-vibe" }),
      checkedAt: "2026-11-18T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "mistral-vibe",
        version: "3.1.1",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    // Mistral Vibe 3.1.1 sends its levels under category "thinking", for the session's model only.
    const vibeSession = (model: string, levels: ReadonlyArray<string>) =>
      normalizeAcpRegistryLiveConfiguration([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model,
          options: ["mistral-large-4-0-3", "mistral-medium-3.5"].map((value) => ({
            value,
            name: value,
          })),
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thinking",
          type: "select",
          currentValue: "high",
          options: levels.map((value) => ({ value, name: value })),
        },
      ]);
    const thinking = (levels: ReadonlyArray<string>) => ({
      id: "thinking",
      label: "Thinking",
      type: "select",
      options: levels.map((id) => ({ id, label: id })),
      currentValue: "high",
      role: "reasoning",
    });
    const descriptors = (snapshot: typeof provider) =>
      snapshot.models.map((model) => [model.slug, model.capabilities?.optionDescriptors ?? []]);

    const onLarge = applyAcpRegistryLiveConfiguration(
      provider,
      vibeSession("mistral-large-4-0-3", ["low", "medium", "high"]),
      [],
    );
    expect(descriptors(onLarge)).toEqual([
      ["mistral-large-4-0-3", [thinking(["low", "medium", "high"])]],
      ["mistral-medium-3.5", []],
    ]);
    const onMedium = applyAcpRegistryLiveConfiguration(
      onLarge,
      vibeSession("mistral-medium-3.5", ["off", "high"]),
      [],
    );
    expect(descriptors(onMedium)).toEqual([
      ["mistral-large-4-0-3", [thinking(["low", "medium", "high"])]],
      ["mistral-medium-3.5", [thinking(["off", "high"])]],
    ]);
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toEqual({ ...environment, MISE_OFFLINE: "1" });
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );

  it("keeps a richer probed catalog when a live session reports one provisional model", () => {
    const provider = providerWithModels(
      [
        { id: "auto", name: "Auto", description: null },
        { id: "qmodel", name: "Qwen", description: null },
        { id: "kmodel", name: "Kimi", description: null },
      ],
      "auto",
    );

    const fallbackSelected = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "smodel", name: "Default", description: null }],
        currentModelId: "smodel",
        configOptions: [],
        modelsFromModelSelect: false,
      },
      [],
    );
    expect(fallbackSelected.models.map((m) => m.slug)).toEqual(["auto", "qmodel", "kmodel"]);
    expect(fallbackSelected.models.find((m) => m.slug === "auto")?.isDefault).toBe(true);

    const liveSelected = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "auto", name: "Auto", description: null }],
        currentModelId: "qmodel",
        configOptions: [],
        modelsFromModelSelect: false,
      },
      [],
    );
    expect(liveSelected.models.map((m) => m.slug)).toEqual(["auto", "qmodel", "kmodel"]);
    expect(liveSelected.models.find((m) => m.slug === "qmodel")?.isDefault).toBe(true);
    expect(liveSelected.models.find((m) => m.slug === "auto")?.isDefault).not.toBe(true);
  });

  it("honors an explicit single-model select even when it is absent from the probe catalog", () => {
    const provider = providerWithModels(
      [
        { id: "auto", name: "Auto", description: null },
        { id: "qmodel", name: "Qwen", description: null },
        { id: "kmodel", name: "Kimi", description: null },
      ],
      "auto",
    );

    const entitledEffort = {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      currentValue: "high",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    const placeholderEffort = {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      currentValue: "on",
      options: [
        { id: "off", label: "Off" },
        { id: "on", label: "On" },
      ],
    };
    const sharedMode = {
      id: "mode",
      label: "Mode",
      type: "select" as const,
      currentValue: "code",
      options: [{ id: "code", label: "Code" }],
    };

    const entitled = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "gmodel", name: "GPT-Pro", description: null }],
        currentModelId: "gmodel",
        configOptions: [entitledEffort],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: true,
      },
      [],
    );
    expect(entitled.models.map((m) => m.slug)).toEqual(["gmodel"]);
    expect(entitled.models.find((m) => m.slug === "gmodel")?.isDefault).toBe(true);

    const afterProvisional = applyAcpRegistryLiveConfiguration(
      entitled,
      {
        models: [{ id: "placeholder", name: "Placeholder", description: null }],
        currentModelId: "placeholder",
        configOptions: [placeholderEffort, sharedMode],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
      },
      [],
      entitled.models,
      { preserveSingleModelCatalog: true },
    );
    expect(afterProvisional.models.map((m) => m.slug)).toEqual(["gmodel"]);
    expect(afterProvisional.models.find((m) => m.slug === "gmodel")?.isDefault).toBe(true);
    expect(
      afterProvisional.models.find((m) => m.slug === "gmodel")?.capabilities?.optionDescriptors,
    ).toEqual([sharedMode, entitledEffort]);

    const afterProvisionalModelOnly = applyAcpRegistryLiveConfiguration(
      entitled,
      {
        models: [{ id: "placeholder", name: "Placeholder", description: null }],
        currentModelId: "placeholder",
        configOptions: [placeholderEffort],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
      },
      [],
      entitled.models,
      { preserveSingleModelCatalog: true },
    );
    expect(afterProvisionalModelOnly.models).toBe(entitled.models);

    // An options-only update with no currentModelId on a discovered catalog (even one whose
    // model ID happens to be "default") applies only shared options and leaves own options alone.
    const discoveredNamedDefault = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "default", name: "Default Model", description: null }],
        currentModelId: "default",
        configOptions: [entitledEffort],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: true,
      },
      [],
    );
    const afterUnknownModelOptions = applyAcpRegistryLiveConfiguration(
      discoveredNamedDefault,
      {
        models: [],
        currentModelId: null,
        configOptions: [placeholderEffort, sharedMode],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
      },
      [],
      discoveredNamedDefault.models,
      { hasDiscoveredCatalog: true },
    );
    expect(afterUnknownModelOptions.models.find((m) => m.slug === "default")?.isDefault).toBe(true);
    expect(
      afterUnknownModelOptions.models.find((m) => m.slug === "default")?.capabilities
        ?.optionDescriptors,
    ).toEqual([sharedMode, entitledEffort]);

    // Synthetic placeholder ("default" without a discovered catalog) still accepts model options.
    const syntheticDefault = providerWithModels([], null);
    const afterSyntheticOptions = applyAcpRegistryLiveConfiguration(
      syntheticDefault,
      {
        models: [],
        currentModelId: null,
        configOptions: [placeholderEffort, sharedMode],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
      },
      [],
      syntheticDefault.models,
      { hasDiscoveredCatalog: false },
    );
    expect(
      afterSyntheticOptions.models.find((m) => m.slug === "default")?.capabilities
        ?.optionDescriptors,
    ).toEqual([placeholderEffort, sharedMode]);

    const replacedExplicit = applyAcpRegistryLiveConfiguration(
      entitled,
      {
        models: [{ id: "hmodel", name: "Haiku-Only", description: null }],
        currentModelId: "hmodel",
        configOptions: [],
        modelsFromModelSelect: true,
      },
      [],
      entitled.models,
      { preserveSingleModelCatalog: true },
    );
    expect(replacedExplicit.models.map((m) => m.slug)).toEqual(["hmodel"]);
    expect(replacedExplicit.models.find((m) => m.slug === "hmodel")?.isDefault).toBe(true);

    const narrowed = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "qmodel", name: "Qwen", description: null }],
        currentModelId: "qmodel",
        configOptions: [],
        modelsFromModelSelect: true,
      },
      [],
    );
    expect(narrowed.models.map((m) => m.slug)).toEqual(["qmodel"]);
    expect(narrowed.models.find((m) => m.slug === "qmodel")?.isDefault).toBe(true);
  });
});

describe("acpRegistryEnrichmentCache", () => {
  it("reuses a local probe until expiry even when inspection has no version", () => {
    const entry = { provider: providerWithModels([], null), expiresAt: 1_000 };
    expect(isAcpRegistryCacheValid(entry, null, true, 999)).toBe(true);
    expect(isAcpRegistryCacheValid(entry, null, true, 1_000)).toBe(false);
    expect(isAcpRegistryCacheValid(entry, "2.0.0", false, 999)).toBe(false);
    expect(isAcpRegistryCacheValid(entry, "1.0.0", false, 999)).toBe(true);
  });
  const settledConfiguration = {
    models: [
      { id: "auto", name: "Auto", description: null },
      { id: "qmodel", name: "Qwen", description: null },
      { id: "kmodel", name: "Kimi", description: null },
    ],
    currentModelId: "auto",
    configOptions: [],
    modelsFromModelSelect: true,
  };

  it("does not renew the cache deadline when live configuration is replayed unchanged", () => {
    const provider = providerWithModels(settledConfiguration.models, "auto");
    const cache = { generation: 1, entry: { provider, expiresAt: 1_000 } };

    const replayed = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 2_000,
    });

    expect(replayed).toBe(cache);
    expect(replayed.entry?.expiresAt).toBe(1_000);

    const explicitSingletonCache = {
      generation: 1,
      entry: {
        provider: providerWithModels(
          [{ id: "gmodel", name: "GPT-Pro", description: null }],
          "gmodel",
        ),
        expiresAt: 1_000,
      },
    };
    const provisionalUpdate = updateAcpRegistryEnrichmentCache({
      cache: explicitSingletonCache,
      configuration: {
        models: [{ id: "placeholder", name: "Placeholder", description: null }],
        currentModelId: "placeholder",
        configOptions: [],
        modelsFromModelSelect: false,
      },
      customModels: [],
      now: 2_000,
      preserveSingleModelCatalog: true,
    });
    expect(provisionalUpdate).toBe(explicitSingletonCache);
    expect(provisionalUpdate.entry?.provider.models.map((m) => m.slug)).toEqual(["gmodel"]);

    const optionsOnly = prepareAcpRegistryLiveConfiguration(
      [
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ],
      undefined,
      {
        currentModelId: "auto",
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "qmodel", name: "Qwen" },
        ],
      },
    ).toLiveConfiguration({ includeCatalog: false });
    expect(optionsOnly.models).toEqual([]);
    expect(optionsOnly.currentModelId).toBe("auto");
    expect(optionsOnly.modelsFromModelSelect).toBe(false);
    expect(optionsOnly.modelOptionIds).toEqual(["effort"]);
    const afterOptionsOnly = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: optionsOnly,
      customModels: [],
      now: 2_000,
    });
    expect(afterOptionsOnly.generation).toBe(1);
    expect(afterOptionsOnly.entry?.expiresAt).toBe(1_000);
    expect(
      afterOptionsOnly.entry?.provider.models
        .find((m) => m.slug === "auto")
        ?.capabilities?.optionDescriptors?.map((option) => option.id),
    ).toEqual(["effort"]);
  });

  it("updates the cache and promotes the expiry when live configuration discovers a catalog", () => {
    const provider = providerWithModels(
      [{ id: "smodel", name: "Default", description: null }],
      "smodel",
    );
    const cache = { generation: 1, entry: { provider, expiresAt: 1_000 } };

    const updated = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
    });

    expect(updated.entry?.provider.models.map((m) => m.slug)).toEqual(["auto", "qmodel", "kmodel"]);
    expect((updated.entry?.expiresAt ?? 0) - 5_000).toBe(15 * 60 * 1_000);
    expect(updated.generation).toBe(2);
  });

  it("advances the cache epoch when a live catalog arrives before any probe lands", () => {
    const cache = { generation: 4, entry: null };

    expect(
      updateAcpRegistryEnrichmentCache({
        cache,
        configuration: {
          models: [],
          currentModelId: "auto",
          configOptions: [],
          modelsFromModelSelect: false,
        },
        customModels: [],
        now: 5_000,
      }),
    ).toBe(cache);

    const updated = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
    });

    expect(updated.generation).toBe(5);
    expect(updated.entry).toBeNull();
  });

  it("lets authoritative fresh probes supersede live catalogs without letting provisional probes regress them", () => {
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 3,
        probedModelsFromModelSelect: false,
        liveModelCount: 2,
        liveModelsFromModelSelect: true,
      }),
    ).toBe(true);
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 1,
        probedModelsFromModelSelect: true,
        liveModelCount: 3,
        liveModelsFromModelSelect: true,
      }),
    ).toBe(true);
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 1,
        probedModelsFromModelSelect: true,
        liveModelCount: 1,
        liveModelsFromModelSelect: true,
      }),
    ).toBe(true);
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 1,
        probedModelsFromModelSelect: false,
        liveModelCount: 1,
        liveModelsFromModelSelect: false,
      }),
    ).toBe(true);
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 1,
        probedModelsFromModelSelect: false,
        liveModelCount: 1,
        liveModelsFromModelSelect: true,
      }),
    ).toBe(false);
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 1,
        probedModelsFromModelSelect: false,
        liveModelCount: 3,
        liveModelsFromModelSelect: true,
      }),
    ).toBe(false);
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 0,
        probedModelsFromModelSelect: false,
        liveModelCount: 2,
        liveModelsFromModelSelect: true,
      }),
    ).toBe(false);
    // When neither source advertises models, an empty probe keeps live options on synthetic default.
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 0,
        probedModelsFromModelSelect: false,
        liveModelCount: 0,
        liveModelsFromModelSelect: false,
      }),
    ).toBe(false);
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 1,
        probedModelsFromModelSelect: false,
        liveModelCount: 0,
        liveModelsFromModelSelect: false,
      }),
    ).toBe(true);
  });
  it("retains only compatible live overrides across superseding probes without storing probe defaults or stripping default-model options", () => {
    const mode = (currentValue: "ask" | "code" | "removed") => ({
      id: "mode",
      label: "Mode",
      type: "select" as const,
      currentValue,
      options: [
        { id: "ask", label: "Ask" },
        { id: "code", label: "Code" },
      ],
    });
    const effort = (
      currentValue: "low" | "high",
      choices: ReadonlyArray<"low" | "high"> = ["low", "high"],
    ) => ({
      id: "effort",
      label: "Effort",
      type: "select" as const,
      role: "reasoning" as const,
      currentValue,
      options: choices.map((id) => ({ id, label: id === "low" ? "Low" : "High" })),
    });
    const legacy = {
      id: "legacy",
      label: "Legacy",
      type: "select" as const,
      currentValue: "on",
      options: [{ id: "on", label: "On" }],
    };
    const fast = (currentValue: boolean) => ({
      id: "fast",
      label: "Fast",
      type: "boolean" as const,
      currentValue,
    });

    const retained = retainAcpRegistryLiveOptionsAfterProbe(
      {
        models: [],
        currentModelId: "old-model",
        configOptions: [mode("code"), legacy, effort("low")],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
      },
      {
        models: [
          { id: "new-model", name: "new-model", description: null },
          { id: "old-model", name: "old-model", description: null },
        ],
        currentModelId: "new-model",
        configOptions: [mode("ask"), fast(false), effort("high")],
        modelOptionIds: new Set(["effort"]),
      },
    );
    // Probe-only defaults (fast=false) must not be stored as live overrides.
    expect(retained).toEqual(
      Option.some({
        models: [],
        currentModelId: "old-model",
        configOptions: [mode("code"), effort("low")],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
        partialOptions: true,
        replaceModelOptions: true,
      }),
    );

    // Applying the retained override onto a later probe where fast=true preserves mode=code
    // and keeps the new probe default fast=true instead of reverting it to false.
    const probeWithFast = (fastDefault: boolean) =>
      buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: "1.0.0",
          distribution: "npx",
        },
        probe: {
          probe: {
            instanceId: identity.instanceId,
            ready: true,
            icon: null,
            authMethods: [],
            models: [
              { id: "new-model", name: "new-model", description: null },
              { id: "old-model", name: "old-model", description: null },
            ],
            currentModelId: "new-model",
            configOptions: [mode("ask"), fast(fastDefault), effort("high")],
            modelOptionIds: ["effort"],
            sessionManagement: noSessionManagement,
          },
          slashCommands: [],
          skills: [],
        },
      });
    const appliedProbe2 = applyAcpRegistryLiveConfiguration(
      probeWithFast(true),
      Option.getOrThrow(retained),
      [],
    );
    expect(
      appliedProbe2.models
        .find((m) => m.slug === "new-model")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([
      ["mode", "code"],
      ["fast", true],
      ["effort", "high"],
    ]);
    expect(
      appliedProbe2.models
        .find((m) => m.slug === "old-model")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([
      ["mode", "code"],
      ["fast", true],
      ["effort", "low"],
    ]);

    // When the live session's model was removed upstream, keep live.currentModelId so the
    // probe's default model retains its own model-specific options (effort) alongside shared mode=code.
    const retainedAfterRemovedModel = Option.getOrThrow(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "removed-model",
          configOptions: [mode("code"), effort("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        },
        {
          models: [
            { id: "new-model", name: "new-model", description: null },
            { id: "old-model", name: "old-model", description: null },
          ],
          currentModelId: "new-model",
          configOptions: [mode("ask"), fast(false), effort("high")],
          modelOptionIds: new Set(["effort"]),
        },
      ),
    );
    expect(retainedAfterRemovedModel.currentModelId).toBe("removed-model");
    const appliedRemovedModel = applyAcpRegistryLiveConfiguration(
      probeWithFast(false),
      retainedAfterRemovedModel,
      [],
    );
    expect(appliedRemovedModel.models.find((m) => m.slug === "new-model")?.isDefault).toBe(true);
    expect(
      appliedRemovedModel.models
        .find((m) => m.slug === "new-model")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([
      ["mode", "code"],
      ["fast", false],
      ["effort", "high"],
    ]);

    // Invalid or removed live values are dropped rather than storing probe fallbacks as overrides.
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [mode("removed"), effort("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        },
        {
          models: [{ id: "old-model", name: "old-model", description: null }],
          currentModelId: "old-model",
          configOptions: [mode("ask"), effort("low", ["low"])],
          modelOptionIds: new Set(["effort"]),
        },
      ),
    ).toEqual(Option.none());
    // Valid live values on the same model survive while removed values are dropped.
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [mode("code"), effort("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        },
        {
          models: [{ id: "old-model", name: "old-model", description: null }],
          currentModelId: "old-model",
          configOptions: [mode("ask"), effort("low", ["low"])],
          modelOptionIds: new Set(["effort"]),
        },
      ),
    ).toEqual(
      Option.some({
        models: [],
        currentModelId: "old-model",
        configOptions: [mode("code"), effort("low", ["low"])],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
        partialOptions: true,
      }),
    );

    // Drops reasoning when the probe disables it, while keeping currentModelId selection when it differs from probe default.
    const selectionOnly = Option.some({
      models: [],
      currentModelId: "old-model",
      configOptions: [],
      modelOptionIds: [],
      modelsFromModelSelect: false,
      partialOptions: true,
      replaceModelOptions: true,
    });
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [legacy, effort("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        },
        {
          models: [
            { id: "new-model", name: "new-model", description: null },
            { id: "old-model", name: "old-model", description: null, reasoningEffort: null },
          ],
          currentModelId: "new-model",
          configOptions: [effort("high")],
          modelOptionIds: new Set(["effort"]),
        },
      ),
    ).toEqual(selectionOnly);
    const appliedSelectionOnly = applyAcpRegistryLiveConfiguration(
      probeWithFast(false),
      Option.getOrThrow(selectionOnly),
      [],
    );
    expect(appliedSelectionOnly.models.find((m) => m.slug === "old-model")?.isDefault).toBe(true);
    expect(
      appliedSelectionOnly.models
        .find((m) => m.slug === "old-model")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([
      ["mode", "ask"],
      ["fast", false],
    ]);

    // Drops model-specific options when the probe ran directly on that model without them.
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [effort("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        },
        {
          models: [{ id: "old-model", name: "old-model", description: null }],
          currentModelId: "old-model",
          configOptions: [],
          modelOptionIds: new Set(),
        },
      ),
    ).toEqual(Option.none());

    // Never promotes a live model-specific option into a probe-shared option across models,
    // retaining only model selection when no options survive on a different probed model.
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [fast(true)],
          modelOptionIds: ["fast"],
          modelsFromModelSelect: false,
        },
        {
          models: [
            { id: "new-model", name: "new-model", description: null },
            { id: "old-model", name: "old-model", description: null },
          ],
          currentModelId: "new-model",
          configOptions: [fast(false)],
          modelOptionIds: new Set(),
        },
      ),
    ).toEqual(selectionOnly);

    // Second-clear retention preserves replaceModelOptions only when the partial entry already
    // carried it, and does not drop an earlier preserveDefault replacement entry.
    const secondClearSchema = {
      models: [
        { id: "new-model", name: "new-model", description: null },
        { id: "old-model", name: "old-model", description: null },
      ],
      currentModelId: "new-model",
      configOptions: [],
      modelOptionIds: new Set<string>(),
    };
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          partialOptions: true,
          preserveDefault: true,
          replaceModelOptions: true,
        },
        secondClearSchema,
      ),
    ).toEqual(selectionOnly);
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          partialOptions: true,
        },
        secondClearSchema,
      ),
    ).toEqual(
      Option.some({
        models: [],
        currentModelId: "old-model",
        configOptions: [],
        modelOptionIds: [],
        modelsFromModelSelect: false,
        partialOptions: true,
      }),
    );

    // Never promotes a live shared option into a probe model-specific option on the probe's current model.
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [fast(true)],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        },
        {
          models: [{ id: "old-model", name: "old-model", description: null }],
          currentModelId: "old-model",
          configOptions: [fast(false)],
          modelOptionIds: new Set(["fast"]),
        },
      ),
    ).toEqual(Option.none());

    // Off-current reasoning retention requires matching native option IDs (thinking != effort).
    expect(
      retainAcpRegistryLiveOptionsAfterProbe(
        {
          models: [],
          currentModelId: "old-model",
          configOptions: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              currentValue: "low",
              options: [{ id: "low", label: "Low" }],
            },
          ],
          modelOptionIds: ["thinking"],
          modelsFromModelSelect: false,
        },
        {
          models: [
            { id: "new-model", name: "new-model", description: null },
            {
              id: "old-model",
              name: "old-model",
              description: null,
              reasoningEffort: effort("high"),
            },
          ],
          currentModelId: "new-model",
          configOptions: [effort("high")],
          modelOptionIds: new Set(["effort"]),
        },
      ),
    ).toEqual(selectionOnly);
  });
});

describe("prepareAcpRegistryLiveConfiguration", () => {
  it("keeps catalogKey stable across selection and effort toggles while carrying overflow selection, detecting renames, and safely projecting per-model reasoning", () => {
    const modelSelect = (
      currentValue: string,
      options: ReadonlyArray<{ value: string; name: string }>,
    ) => [
      {
        id: "model",
        name: "Model",
        category: "model" as const,
        type: "select" as const,
        currentValue,
        options: [...options],
      },
    ];
    const choices = Array.from({ length: 257 }, (_, index) => ({
      value: `m${index}`,
      name: `Model ${index}`,
    }));

    const keyM0 = prepareAcpRegistryLiveConfiguration(modelSelect("m0", choices)).catalogKey;
    expect(prepareAcpRegistryLiveConfiguration(modelSelect("m1", choices)).catalogKey).toBe(keyM0);
    const preparedM256 = prepareAcpRegistryLiveConfiguration(modelSelect("m256", choices));
    expect(preparedM256.catalogKey).toBe(keyM0);
    const overflowOptionsOnly = preparedM256.toLiveConfiguration({ includeCatalog: false });
    expect(overflowOptionsOnly.models).toEqual([]);
    expect(overflowOptionsOnly.cappedPrefixKey).toBeDefined();
    expect(overflowOptionsOnly.cappedLastModel).toEqual({
      id: "m256",
      name: "Model 256",
      description: null,
    });
    const cappedProvider = providerWithModels(
      choices.slice(0, 256).map((choice) => ({
        id: choice.value,
        name: choice.name,
        description: null,
      })),
      "m0",
    );
    const withOverflowSelected = applyAcpRegistryLiveConfiguration(
      cappedProvider,
      overflowOptionsOnly,
      [],
    );
    expect(withOverflowSelected.models).toHaveLength(256);
    expect(withOverflowSelected.models.at(-1)?.slug).toBe("m256");
    expect(withOverflowSelected.models.at(-1)?.isDefault).toBe(true);
    // Returning to the stable prefix (m0 or m1) restores m255 into the last slot without re-sending the catalog.
    const withM0Restored = applyAcpRegistryLiveConfiguration(
      withOverflowSelected,
      prepareAcpRegistryLiveConfiguration(modelSelect("m0", choices)).toLiveConfiguration({
        includeCatalog: false,
      }),
      [],
    );
    expect(withM0Restored.models).toHaveLength(256);
    expect(withM0Restored.models.at(-1)?.slug).toBe("m255");
    expect(withM0Restored.models[0]?.isDefault).toBe(true);
    // Switching back to m255 from m256 also restores m255 and marks it default.
    const withM255Restored = applyAcpRegistryLiveConfiguration(
      withOverflowSelected,
      prepareAcpRegistryLiveConfiguration(modelSelect("m255", choices)).toLiveConfiguration({
        includeCatalog: false,
      }),
      [],
    );
    expect(withM255Restored.models).toHaveLength(256);
    expect(withM255Restored.models.at(-1)?.slug).toBe("m255");
    expect(withM255Restored.models.at(-1)?.isDefault).toBe(true);
    // Removing the last overflow choice (257 -> 256 choices, m0 selected) still restores m255.
    const afterOverflowRemoved = applyAcpRegistryLiveConfiguration(
      withOverflowSelected,
      prepareAcpRegistryLiveConfiguration(
        modelSelect("m0", choices.slice(0, 256)),
      ).toLiveConfiguration({ includeCatalog: false }),
      [],
    );
    expect(afterOverflowRemoved.models).toHaveLength(256);
    expect(afterOverflowRemoved.models.at(-1)?.slug).toBe("m255");
    expect(afterOverflowRemoved.models[0]?.isDefault).toBe(true);
    // A custom display-name override on m0 must not block matching overflow updates.
    const renamedCappedProvider = {
      ...cappedProvider,
      models: cappedProvider.models.map((model, index) =>
        index === 0 ? { ...model, name: "Custom M0" } : model,
      ),
    };
    const withRenamedOverflow = applyAcpRegistryLiveConfiguration(
      renamedCappedProvider,
      overflowOptionsOnly,
      [],
    );
    expect(withRenamedOverflow.models.at(-1)?.slug).toBe("m256");
    expect(withRenamedOverflow.models.at(-1)?.isDefault).toBe(true);
    // An overflow model that is also configured as custom must appear once with its custom
    // display name in partial overlays, and reappear as custom when m255 returns to slot 255
    // without inheriting another custom model's bespoke capabilities.
    const customM256 = [
      toCustomModelSetting({
        slug: "gateway/fast",
        name: "Fast",
        capabilities: {
          optionDescriptors: [{ id: "fast", label: "Fast", type: "boolean" }],
        },
      }),
      toCustomModelSetting({ slug: "m256", name: "Custom M256", capabilities: null }),
    ];
    const effortOption = (currentValue: "low" | "high") => ({
      id: "effort",
      name: "Effort",
      category: "thought_level" as const,
      type: "select" as const,
      currentValue,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    });
    const probeM0Config = prepareAcpRegistryLiveConfiguration([
      ...modelSelect("m0", choices),
      effortOption("low"),
    ]).toLiveConfiguration({ includeCatalog: true });
    const cappedWithCustom = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent", customModels: customM256 }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          sessionManagement: noSessionManagement,
          models: probeM0Config.models,
          currentModelId: probeM0Config.currentModelId,
          configOptions: probeM0Config.configOptions,
          ...(probeM0Config.modelOptionIds === undefined
            ? {}
            : { modelOptionIds: probeM0Config.modelOptionIds }),
        },
        slashCommands: [],
        skills: [],
      },
    });
    const probeM0Schema = {
      models: probeM0Config.models,
      currentModelId: probeM0Config.currentModelId,
      configOptions: probeM0Config.configOptions,
      modelOptionIds: new Set(probeM0Config.modelOptionIds ?? []),
    };
    const retainedCustomOverflow = Option.getOrThrow(
      retainAcpRegistryLiveOptionsAfterProbe(
        prepareAcpRegistryLiveConfiguration([
          ...modelSelect("m256", choices),
          effortOption("high"),
        ]).toLiveConfiguration({ includeCatalog: false }),
        probeM0Schema,
      ),
    );
    const partialCustomOverflow = applyAcpRegistryLiveConfiguration(
      cappedWithCustom,
      retainedCustomOverflow,
      customM256,
      cappedWithCustom.models,
      { probeConfigOptions: probeM0Config.configOptions },
    );
    const overflowMatches = partialCustomOverflow.models.filter((model) => model.slug === "m256");
    expect(overflowMatches).toHaveLength(1);
    expect(overflowMatches[0]).toMatchObject({
      slug: "m256",
      name: "Custom M256",
      isCustom: false,
      isDefault: true,
    });
    expect(
      overflowMatches[0]?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")
        ?.currentValue,
    ).toBe("high");
    const restoredAfterCustomOverflow = applyAcpRegistryLiveConfiguration(
      partialCustomOverflow,
      {
        ...prepareAcpRegistryLiveConfiguration(modelSelect("m0", choices)).toLiveConfiguration({
          includeCatalog: false,
        }),
        partialOptions: true,
      },
      customM256,
      partialCustomOverflow.models,
      { probeConfigOptions: probeM0Config.configOptions },
    );
    expect(restoredAfterCustomOverflow.models.filter((m) => !m.isCustom).at(-1)?.slug).toBe("m255");
    const restoredCustomM256 = restoredAfterCustomOverflow.models.filter((m) => m.slug === "m256");
    expect(restoredCustomM256).toHaveLength(1);
    expect(restoredCustomM256[0]).toMatchObject({
      slug: "m256",
      name: "Custom M256",
      isCustom: true,
    });
    const restoredWithoutProbeCaps = applyAcpRegistryLiveConfiguration(
      partialCustomOverflow,
      {
        ...prepareAcpRegistryLiveConfiguration(modelSelect("m0", choices)).toLiveConfiguration({
          includeCatalog: false,
        }),
        partialOptions: true,
      },
      customM256,
      partialCustomOverflow.models,
    );
    expect(
      restoredWithoutProbeCaps.models
        .find((m) => m.slug === "m256" && m.isCustom)
        ?.capabilities?.optionDescriptors?.map((d) => d.id),
    ).toEqual([]);
    // Retained overflow options replace an older learned schema for the same ID while keeping
    // unrelated learned options and validating shared descriptors against the probe.
    const modeSelect = (currentValue: "ask" | "code", values: ReadonlyArray<"ask" | "code">) => ({
      id: "mode",
      name: "Mode",
      category: "mode" as const,
      type: "select" as const,
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    });
    const probeModeOnly = prepareAcpRegistryLiveConfiguration([
      ...modelSelect("m0", choices),
      modeSelect("ask", ["ask"]),
    ]).toLiveConfiguration({ includeCatalog: true });
    const retainedV2Overflow = Option.getOrThrow(
      retainAcpRegistryLiveOptionsAfterProbe(
        prepareAcpRegistryLiveConfiguration([
          ...modelSelect("m256", choices),
          modeSelect("code", ["ask", "code"]),
          {
            id: "variant",
            name: "Variant",
            category: "model_config" as const,
            type: "select" as const,
            currentValue: "v2",
            options: [{ value: "v2", name: "V2" }],
          },
        ]).toLiveConfiguration({ includeCatalog: false }),
        {
          models: probeModeOnly.models,
          currentModelId: probeModeOnly.currentModelId,
          configOptions: probeModeOnly.configOptions,
          modelOptionIds: new Set(probeModeOnly.modelOptionIds ?? []),
        },
      ),
    );
    const oldLearnedM256 = [
      {
        slug: "m256",
        name: "Model 256",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              currentValue: "v1",
              options: [{ id: "v1", label: "V1" }],
            },
            {
              id: "style",
              label: "Style",
              type: "select" as const,
              currentValue: "s1",
              options: [{ id: "s1", label: "S1" }],
            },
          ],
        },
      },
    ];
    const appliedV2Overflow = applyAcpRegistryLiveConfiguration(
      cappedProvider,
      retainedV2Overflow,
      [],
      oldLearnedM256,
      { probeSharedDescriptors: probeModeOnly.configOptions },
    );
    expect(
      appliedV2Overflow.models
        .at(-1)
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([
      ["mode", "ask"],
      ["style", "s1"],
      ["variant", "v2"],
    ]);
    // A probe starting on overflow m256 tags its tail so retained live updates on m5 or m255
    // restore m255 into slot 255 while keeping the running session's default and effort.
    const probeOverflowM256 = prepareAcpRegistryLiveConfiguration([
      ...modelSelect("m256", choices),
      effortOption("low"),
    ]).toLiveConfiguration({ includeCatalog: true });
    expect(probeOverflowM256.cappedTailIsOverflow).toBe(true);
    const probeOverflowSnapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          sessionManagement: noSessionManagement,
          models: probeOverflowM256.models,
          currentModelId: probeOverflowM256.currentModelId,
          configOptions: probeOverflowM256.configOptions,
          ...(probeOverflowM256.modelOptionIds === undefined
            ? {}
            : { modelOptionIds: probeOverflowM256.modelOptionIds }),
        },
        slashCommands: [],
        skills: [],
        cappedTailIsOverflow: true,
      },
    });
    const probeOverflowSchema = {
      models: probeOverflowM256.models,
      currentModelId: probeOverflowM256.currentModelId,
      configOptions: probeOverflowM256.configOptions,
      modelOptionIds: new Set(probeOverflowM256.modelOptionIds ?? []),
      cappedTailIsOverflow: true,
    };
    for (const activeSlug of ["m5", "m255"] as const) {
      const retainedOverOverflowProbe = Option.getOrThrow(
        retainAcpRegistryLiveOptionsAfterProbe(
          prepareAcpRegistryLiveConfiguration([
            ...modelSelect(activeSlug, choices),
            effortOption("high"),
          ]).toLiveConfiguration({ includeCatalog: false }),
          probeOverflowSchema,
        ),
      );
      const appliedOverOverflowProbe = applyAcpRegistryLiveConfiguration(
        probeOverflowSnapshot,
        retainedOverOverflowProbe,
        [],
        probeOverflowSnapshot.models,
        { probeConfigOptions: probeOverflowM256.configOptions },
      );
      expect(appliedOverOverflowProbe.models.at(-1)?.slug).toBe("m255");
      const defaultModel = appliedOverOverflowProbe.models.find((m) => m.isDefault);
      expect(defaultModel?.slug).toBe(activeSlug);
      expect(
        defaultModel?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue,
      ).toBe("high");
    }
    // Cache equality shortcuts must not drop an overflow-tail tag change when a model is
    // inserted at index 255 while keeping the same visible list [m0..m254, m256].
    const catalogWithoutM255 = [...choices.slice(0, 255), choices[256]!];
    const untaggedM256Snapshot = providerWithModels(
      catalogWithoutM255.map((choice) => ({
        id: choice.value,
        name: choice.name,
        description: null,
      })),
      "m256",
    );
    const cacheAfterOverflowTag = updateAcpRegistryEnrichmentCache({
      cache: { generation: 1, entry: { provider: untaggedM256Snapshot, expiresAt: 100_000 } },
      configuration: prepareAcpRegistryLiveConfiguration(
        modelSelect("m256", choices),
      ).toLiveConfiguration({ includeCatalog: true }),
      customModels: [],
      now: 1_000,
    });
    expect(cacheAfterOverflowTag.generation).toBe(2);
    const cacheAfterM0Restore = updateAcpRegistryEnrichmentCache({
      cache: cacheAfterOverflowTag,
      configuration: prepareAcpRegistryLiveConfiguration(
        modelSelect("m0", choices),
      ).toLiveConfiguration({ includeCatalog: false }),
      customModels: [],
      now: 2_000,
    });
    expect(cacheAfterM0Restore.entry?.provider.models.at(-1)?.slug).toBe("m255");
    // A session initialized directly on an overflow model (includeCatalog: true) keeps its
    // overflow metadata so a superseding probe on m0 retains the overflow model and its options.
    const choices300 = Array.from({ length: 300 }, (_, index) => ({
      value: `m${index}`,
      name: `Model ${index}`,
    }));
    const catalogOnM299 = prepareAcpRegistryLiveConfiguration([
      ...modelSelect("m299", choices300),
      effortOption("high"),
    ]).toLiveConfiguration({ includeCatalog: true });
    expect(catalogOnM299.cappedPrefixKey).toBeDefined();
    expect(catalogOnM299.cappedLastModel?.id).toBe("m299");
    expect(catalogOnM299.cappedTailIsOverflow).toBe(true);
    const retainedM299 = Option.getOrThrow(
      retainAcpRegistryLiveOptionsAfterProbe(
        { ...catalogOnM299, models: [], modelsFromModelSelect: false },
        probeM0Schema,
      ),
    );
    const appliedM299 = applyAcpRegistryLiveConfiguration(cappedProvider, retainedM299, []);
    expect(appliedM299.models.at(-1)?.slug).toBe("m299");
    expect(appliedM299.models.at(-1)?.isDefault).toBe(true);
    expect(
      appliedM299.models.at(-1)?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")
        ?.currentValue,
    ).toBe("high");
    // A shared-prefix probe advertising a different authoritative tail (new-m255) must not
    // be overwritten by a stale options-only update selecting m0 or removed m255, even when
    // new-m255 is the probe's default model.
    const conflictingTailModels = [
      ...choices.slice(0, 255).map((choice) => ({
        id: choice.value,
        name: choice.name,
        description: null,
      })),
      { id: "new-m255", name: "New Model 255", description: null },
    ];
    const conflictingTailProvider = providerWithModels(conflictingTailModels, "m0");
    const afterConflictingTail = applyAcpRegistryLiveConfiguration(
      conflictingTailProvider,
      prepareAcpRegistryLiveConfiguration(modelSelect("m0", choices)).toLiveConfiguration({
        includeCatalog: false,
      }),
      [],
    );
    expect(afterConflictingTail.models.at(-1)?.slug).toBe("new-m255");
    expect(afterConflictingTail.models[0]?.isDefault).toBe(true);
    const conflictingDefaultTailProvider = providerWithModels(conflictingTailModels, "new-m255");
    const afterConflictingDefaultTailM0 = applyAcpRegistryLiveConfiguration(
      conflictingDefaultTailProvider,
      prepareAcpRegistryLiveConfiguration(modelSelect("m0", choices)).toLiveConfiguration({
        includeCatalog: false,
      }),
      [],
    );
    expect(afterConflictingDefaultTailM0.models.at(-1)?.slug).toBe("new-m255");
    expect(afterConflictingDefaultTailM0.models[0]?.isDefault).toBe(true);
    const afterConflictingDefaultTailM255 = applyAcpRegistryLiveConfiguration(
      conflictingDefaultTailProvider,
      prepareAcpRegistryLiveConfiguration(modelSelect("m255", choices)).toLiveConfiguration({
        includeCatalog: false,
      }),
      [],
    );
    expect(afterConflictingDefaultTailM255.models.at(-1)?.slug).toBe("new-m255");
    expect(afterConflictingDefaultTailM255.models.at(-1)?.isDefault).toBe(true);
    // When live currentModelId is null and the probe started on m256, keep m256 as default.
    const probeOnM256 = providerWithModels(
      [
        ...choices.slice(0, 255).map((choice) => ({
          id: choice.value,
          name: choice.name,
          description: null,
        })),
        { id: "m256", name: "Model 256", description: null },
      ],
      "m256",
    );
    const liveNullCurrent = prepareAcpRegistryLiveConfiguration([], undefined, {
      availableModels: choices.map((choice) => ({ modelId: choice.value, name: choice.name })),
    } as never).toLiveConfiguration({ includeCatalog: false });
    expect(liveNullCurrent.cappedLastModel).toBeUndefined();
    const afterNullCurrent = applyAcpRegistryLiveConfiguration(probeOnM256, liveNullCurrent, []);
    expect(afterNullCurrent.models.at(-1)?.slug).toBe("m256");
    expect(afterNullCurrent.models.at(-1)?.isDefault).toBe(true);
    // A different 256-model catalog (mismatched prefix) must never absorb another session's overflow model.
    const foreign256Provider = providerWithModels(
      Array.from({ length: 256 }, (_, index) => ({
        id: `other-${index}`,
        name: `Other ${index}`,
        description: null,
      })),
      "other-0",
    );
    const afterForeignOverflow = applyAcpRegistryLiveConfiguration(
      foreign256Provider,
      overflowOptionsOnly,
      [],
    );
    expect(afterForeignOverflow.models.at(-1)?.slug).toBe("other-255");
    expect(afterForeignOverflow.models[0]?.isDefault).toBe(true);
    // A smaller catalog must never absorb an overflow model from another session.
    const smallProvider = providerWithModels(
      [
        { id: "p0", name: "P0", description: null },
        { id: "p1", name: "P1", description: null },
      ],
      "p0",
    );
    expect(
      applyAcpRegistryLiveConfiguration(smallProvider, overflowOptionsOnly, []).models.map(
        (model) => model.slug,
      ),
    ).toEqual(["p0", "p1"]);
    expect(
      prepareAcpRegistryLiveConfiguration(
        modelSelect("m0", [{ value: "m0", name: "Model 0 Renamed" }, ...choices.slice(1)]),
      ).catalogKey,
    ).not.toBe(keyM0);
    // Capped probes bound displaced learned-model history while keeping recently seen models
    // (such as m255 displaced by an overflow probe on m256) ahead of older displaced entries.
    const variantCapabilities = {
      optionDescriptors: [
        {
          id: "variant",
          label: "Variant",
          type: "select" as const,
          currentValue: "v1",
          options: [{ id: "v1", label: "V1" }],
        },
      ],
    };
    const absentLearned = Array.from({ length: MAX_DISPLACED_LEARNED_MODELS + 10 }, (_, index) => ({
      slug: `old-${index}`,
      name: `Old ${index}`,
      isCustom: false,
      capabilities: variantCapabilities,
    }));
    const m255Learned = {
      slug: "m255",
      name: "Model 255",
      isCustom: false,
      capabilities: variantCapabilities,
    };
    const probeWithM255 = cappedProvider.models;
    const probeDisplacingM255 = providerWithModels(
      [
        ...choices.slice(0, 255).map((choice) => ({
          id: choice.value,
          name: choice.name,
          description: null,
        })),
        { id: "m256", name: "Model 256", description: null },
      ],
      "m256",
    ).models;
    const learnedAfterProbe1 = updateAcpRegistryLearnedModelsFromProbe(
      [...absentLearned, m255Learned],
      probeWithM255,
      {
        currentModelId: "m0",
        modelOptionIds: new Set(["variant"]),
        reasoningDisabledModelSlugs: new Set(),
      },
    );
    expect(learnedAfterProbe1).toHaveLength(MAX_DISPLACED_LEARNED_MODELS + 1);
    expect(learnedAfterProbe1[0]?.slug).toBe("old-10");
    expect(learnedAfterProbe1.at(-1)?.slug).toBe("m255");
    const learnedAfterProbe2 = updateAcpRegistryLearnedModelsFromProbe(
      learnedAfterProbe1,
      probeDisplacingM255,
      {
        currentModelId: "m256",
        modelOptionIds: new Set(["variant"]),
        reasoningDisabledModelSlugs: new Set(),
      },
    );
    expect(learnedAfterProbe2).toHaveLength(MAX_DISPLACED_LEARNED_MODELS);
    expect(learnedAfterProbe2[0]?.slug).toBe("old-11");
    expect(learnedAfterProbe2.at(-1)?.slug).toBe("m255");
    // An earlier-model overflow entry with preserveDefault does not swap slot 255 or default,
    // yet updateAcpRegistryLearnedModelsFromLive still learns its validated options for m256.
    const earlierOverflowEntry = {
      ...prepareAcpRegistryLiveConfiguration([
        ...modelSelect("m256", choices),
        {
          id: "variant",
          name: "Variant",
          category: "model_config" as const,
          type: "select" as const,
          currentValue: "v2",
          options: [{ value: "v2", name: "V2" }],
        },
      ]).toLiveConfiguration({ includeCatalog: false }),
      partialOptions: true,
      preserveDefault: true,
    };
    const afterEarlierOverflow = applyAcpRegistryLiveConfiguration(
      cappedProvider,
      earlierOverflowEntry,
      [],
    );
    expect(afterEarlierOverflow.models.at(-1)?.slug).toBe("m255");
    expect(afterEarlierOverflow.models[0]?.isDefault).toBe(true);
    const learnedWithEarlierOverflow = updateAcpRegistryLearnedModelsFromLive(
      [],
      afterEarlierOverflow.models,
      earlierOverflowEntry,
    );
    expect(
      learnedWithEarlierOverflow
        .find((m) => m.slug === "m256")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([["variant", "v2"]]);
    // Displaced ordinary tail (m255 when probe started on overflow m256) is also learned
    // off-screen without swapping slot 255 or stealing default.
    const earlierOrdinaryTailEntry = {
      ...prepareAcpRegistryLiveConfiguration([
        ...modelSelect("m255", choices),
        {
          id: "variant",
          name: "Variant",
          category: "model_config" as const,
          type: "select" as const,
          currentValue: "v2",
          options: [{ value: "v2", name: "V2" }],
        },
      ]).toLiveConfiguration({ includeCatalog: false }),
      partialOptions: true,
      preserveDefault: true,
    };
    const afterEarlierOrdinaryTail = applyAcpRegistryLiveConfiguration(
      probeOverflowSnapshot,
      earlierOrdinaryTailEntry,
      [],
    );
    expect(afterEarlierOrdinaryTail.models.at(-1)?.slug).toBe("m256");
    expect(afterEarlierOrdinaryTail.models.at(-1)?.isDefault).toBe(true);
    const learnedWithEarlierOrdinaryTail = updateAcpRegistryLearnedModelsFromLive(
      [],
      afterEarlierOrdinaryTail.models,
      earlierOrdinaryTailEntry,
    );
    expect(
      learnedWithEarlierOrdinaryTail
        .find((m) => m.slug === "m255")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([["variant", "v2"]]);
    // Replacement intent on an off-screen displaced tail replaces (or deletes when empty) prior
    // learned descriptors for m255 instead of merging them back.
    const replacedDisplacedTailEntry = {
      ...prepareAcpRegistryLiveConfiguration([
        ...modelSelect("m255", choices),
        effortOption("high"),
      ]).toLiveConfiguration({ includeCatalog: false }),
      partialOptions: true,
      preserveDefault: true,
    };
    const mergedDisplacedTail = updateAcpRegistryLearnedModelsFromLive(
      learnedWithEarlierOrdinaryTail,
      afterEarlierOrdinaryTail.models,
      replacedDisplacedTailEntry,
    );
    expect(
      mergedDisplacedTail
        .find((m) => m.slug === "m255")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([
      ["variant", "v2"],
      ["effort", "high"],
    ]);
    const replacedDisplacedTail = updateAcpRegistryLearnedModelsFromLive(
      learnedWithEarlierOrdinaryTail,
      afterEarlierOrdinaryTail.models,
      replacedDisplacedTailEntry,
      undefined,
      { replaceCurrentLearnedOptions: true },
    );
    expect(
      replacedDisplacedTail
        .find((m) => m.slug === "m255")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([["effort", "high"]]);
    const clearedDisplacedTail = updateAcpRegistryLearnedModelsFromLive(
      learnedWithEarlierOrdinaryTail,
      afterEarlierOrdinaryTail.models,
      {
        ...prepareAcpRegistryLiveConfiguration(modelSelect("m255", choices)).toLiveConfiguration({
          includeCatalog: false,
        }),
        partialOptions: true,
        preserveDefault: true,
      },
      undefined,
      { replaceCurrentLearnedOptions: true },
    );
    expect(clearedDisplacedTail.some((m) => m.slug === "m255")).toBe(false);
    // Even without replacement intent, an empty displaced-tail update strips reasoning when
    // reasoning is disabled on that model while preserving unrelated learned options, and removes
    // the entry once no descriptors remain.
    const emptyDisabledM255Update = {
      ...prepareAcpRegistryLiveConfiguration(modelSelect("m255", choices)).toLiveConfiguration({
        includeCatalog: false,
      }),
      cappedLastModel: {
        id: "m255",
        name: "Model 255",
        description: null,
        reasoningEffort: null,
      },
      partialOptions: true,
      preserveDefault: true,
    };
    const disabledReasoningPreservingVariant = updateAcpRegistryLearnedModelsFromLive(
      mergedDisplacedTail,
      afterEarlierOrdinaryTail.models,
      emptyDisabledM255Update,
    );
    expect(
      disabledReasoningPreservingVariant
        .find((m) => m.slug === "m255")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([["variant", "v2"]]);
    const disabledReasoningDisplacedTail = updateAcpRegistryLearnedModelsFromLive(
      replacedDisplacedTail,
      afterEarlierOrdinaryTail.models,
      emptyDisabledM255Update,
    );
    expect(disabledReasoningDisplacedTail.some((m) => m.slug === "m255")).toBe(false);
    // An unchanged empty displaced-tail update still refreshes the model's MRU position.
    const m255MergedLearned = mergedDisplacedTail.find((m) => m.slug === "m255")!;
    const learnedWithLaterOther = [
      ...mergedDisplacedTail,
      {
        slug: "m999",
        name: "Model 999",
        isCustom: false,
        capabilities: m255MergedLearned.capabilities,
      },
    ];
    const touchedDisplacedTail = updateAcpRegistryLearnedModelsFromLive(
      learnedWithLaterOther,
      afterEarlierOrdinaryTail.models,
      {
        ...prepareAcpRegistryLiveConfiguration(modelSelect("m255", choices)).toLiveConfiguration({
          includeCatalog: false,
        }),
        partialOptions: true,
        preserveDefault: true,
      },
    );
    expect(touchedDisplacedTail.at(-1)?.slug).toBe("m255");
    expect(
      touchedDisplacedTail
        .find((m) => m.slug === "m255")
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([
      ["variant", "v2"],
      ["effort", "high"],
    ]);
    // Restoring m255 into slot 255 while a different model (m0) is current with its own
    // `variant` option must keep m255's off-screen learned `variant=v2` intact.
    const m0RestoringM255 = {
      ...prepareAcpRegistryLiveConfiguration([
        ...modelSelect("m0", choices),
        {
          id: "variant",
          name: "Variant",
          category: "model_config" as const,
          type: "select" as const,
          currentValue: "v1",
          options: [{ value: "v1", name: "V1" }],
        },
      ]).toLiveConfiguration({ includeCatalog: false }),
      partialOptions: true,
    };
    const afterM0RestoredM255 = applyAcpRegistryLiveConfiguration(
      probeOverflowSnapshot,
      m0RestoringM255,
      [],
      learnedWithEarlierOrdinaryTail,
    );
    expect(afterM0RestoredM255.models.at(-1)?.slug).toBe("m255");
    expect(afterM0RestoredM255.models[0]?.isDefault).toBe(true);
    expect(
      afterM0RestoredM255.models[0]?.capabilities?.optionDescriptors?.map((d) => [
        d.id,
        d.currentValue,
      ]),
    ).toEqual([["variant", "v1"]]);
    expect(
      afterM0RestoredM255.models
        .at(-1)
        ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
    ).toEqual([["variant", "v2"]]);
    // Live learning caps total entries at 256 + MAX_DISPLACED_LEARNED_MODELS, refreshes LRU
    // order when an unchanged model is observed again, and avoids rebuilding when order matches.
    const stableEffort = {
      id: "effort",
      label: "Effort",
      type: "select" as const,
      role: "reasoning" as const,
      currentValue: "high",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    const stableModels = ["a", "b", "c"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: { optionDescriptors: [stableEffort] },
    }));
    const stableCfg = {
      models: [],
      currentModelId: "a",
      configOptions: [stableEffort],
      modelOptionIds: ["effort"],
      modelsFromModelSelect: false,
      advertisedReasoning: { b: stableEffort, c: stableEffort },
    };
    const stableLearned = updateAcpRegistryLearnedModelsFromLive([], stableModels, stableCfg);
    expect(updateAcpRegistryLearnedModelsFromLive(stableLearned, stableModels, stableCfg)).toBe(
      stableLearned,
    );
    const maxLiveLearned = ACP_REGISTRY_MAX_MODELS + MAX_DISPLACED_LEARNED_MODELS;
    const fullLearned = Array.from({ length: maxLiveLearned }, (_, index) => ({
      slug: `live-${index}`,
      name: `Live ${index}`,
      isCustom: false,
      capabilities: variantCapabilities,
    }));
    const touchedOldest = updateAcpRegistryLearnedModelsFromLive(fullLearned, [fullLearned[0]!], {
      models: [],
      currentModelId: "live-0",
      configOptions: variantCapabilities.optionDescriptors,
      modelOptionIds: ["variant"],
      modelsFromModelSelect: false,
    });
    expect(touchedOldest.at(-1)?.slug).toBe("live-0");
    const afterLiveCap = updateAcpRegistryLearnedModelsFromLive(
      touchedOldest,
      [
        {
          slug: "live-new",
          name: "Live New",
          isCustom: false,
          capabilities: variantCapabilities,
        },
      ],
      {
        models: [],
        currentModelId: "live-new",
        configOptions: variantCapabilities.optionDescriptors,
        modelOptionIds: ["variant"],
        modelsFromModelSelect: false,
      },
    );
    expect(afterLiveCap).toHaveLength(maxLiveLearned);
    expect(afterLiveCap.some((m) => m.slug === "live-0")).toBe(true);
    expect(afterLiveCap.some((m) => m.slug === "live-1")).toBe(false);
    expect(afterLiveCap.at(-1)?.slug).toBe("live-new");

    // Toggling an effort selector on a session with a fixed modelState must keep catalogKey
    // stable (so frozen lists never re-advertise over a newer probe) while projecting newly
    // normalized non-current _meta.reasoningEfforts via advertisedReasoning.
    const modelState = {
      currentModelId: "model-a",
      availableModels: [
        { modelId: "model-a", name: "Model A" },
        {
          modelId: "model-b",
          name: "Model B",
          _meta: {
            reasoningEfforts: [{ value: "low", label: "Low" }],
            reasoningEffort: "low",
          },
        },
      ],
    };
    const effortSelect = (currentValue: "low" | "high") => ({
      id: "effort",
      name: "Effort",
      category: "thought_level" as const,
      type: "select" as const,
      currentValue,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    });
    const withoutEffort = prepareAcpRegistryLiveConfiguration([], undefined, modelState);
    const withEffortHigh = prepareAcpRegistryLiveConfiguration(
      [effortSelect("high")],
      undefined,
      modelState,
    );
    const withEffortLow = prepareAcpRegistryLiveConfiguration(
      [effortSelect("low")],
      undefined,
      modelState,
    );
    expect(withEffortHigh.catalogKey).toBe(withoutEffort.catalogKey);
    expect(withEffortLow.catalogKey).toBe(withEffortHigh.catalogKey);
    const optionsOnlyWithEffort = withEffortHigh.toLiveConfiguration({ includeCatalog: false });
    expect(optionsOnlyWithEffort.models).toEqual([]);
    expect(optionsOnlyWithEffort.advertisedReasoning?.["model-b"]).toMatchObject({
      id: "effort",
      currentValue: "low",
      options: [{ id: "low", label: "Low" }],
    });
    const appliedToActive = applyAcpRegistryLiveConfiguration(
      providerWithModels(
        [
          { id: "model-a", name: "Model A", description: null },
          { id: "model-b", name: "Model B", description: null },
          { id: "constructor", name: "Constructor", description: null },
        ],
        "model-a",
      ),
      optionsOnlyWithEffort,
      [],
    );
    expect(
      appliedToActive.models
        .find((model) => model.slug === "model-b")
        ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
    ).toEqual([["effort", "low"]]);
    expect(
      appliedToActive.models.find((model) => model.slug === "constructor")?.capabilities
        ?.optionDescriptors,
    ).toEqual([]);
  });
});

describe("acpRegistryAdvertisesModelCatalog", () => {
  it("counts choices inside option groups and available model state", () => {
    expect(
      acpRegistryAdvertisesModelCatalog([
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          category: "model" as const,
          currentValue: "auto",
          options: [
            {
              groupId: "qwen",
              name: "Qwen",
              options: [
                { value: "auto", name: "Auto" },
                { value: "qmodel", name: "Qwen3.8-Max" },
              ],
            },
          ],
        },
      ]),
    ).toBe(true);
    expect(
      acpRegistryAdvertisesModelCatalog([
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          category: "model" as const,
          currentValue: "smodel",
          options: [{ value: "smodel", name: "Sonus" }],
        },
      ]),
    ).toBe(false);
    expect(acpRegistryAdvertisesModelCatalog(undefined)).toBe(false);
    expect(
      acpRegistryAdvertisesModelCatalog(undefined, {
        availableModels: [
          { modelId: "auto", name: "Auto", description: null },
          { modelId: "qmodel", name: "Qwen", description: null },
        ],
        currentModelId: "auto",
      }),
    ).toBe(true);
  });
});

const fakeAgentSource = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { providers: {}, auth: { logout: {} } },
        authMethods: [{ id: "agent-login", name: "Agent Login" }],
        agentInfo: { name: "fake", version: "1.5.9" },
      },
    });
  } else if (method === "authenticate" || method === "logout" || method === "auth/logout") {
    send({ id, result: {} });
  } else if (method === "session/new") {
    const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
    if (!Array.isArray(payload) && typeof payload.provisional === "string") {
      send({
        id,
        result: {
          sessionId: "probe-session",
          ...(payload.provisional.length === 0
            ? {}
            : {
                models: {
                  currentModelId: payload.provisional,
                  availableModels: [{ modelId: payload.provisional, name: payload.provisional }],
                },
              }),
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: payload.provisional || "transient-a",
              options: [
                { value: payload.provisional || "transient-a", name: payload.provisional || "transient-a" },
                { value: "transient-placeholder", name: "transient-placeholder" },
              ],
            },
          ],
        },
      });
      send({
        method: "session/update",
        params: {
          sessionId: "probe-session",
          update: { sessionUpdate: "config_option_update", configOptions: [] },
        },
      });
      send({
        method: "session/update",
        params: {
          sessionId: "probe-session",
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
        },
      });
      return;
    }
    if (payload && !Array.isArray(payload) && typeof payload.fail === "string") {
      send({
        id,
        error: { code: payload.code ?? -32603, message: payload.fail },
      });
      return;
    }
    const entries = Array.isArray(payload) ? payload : payload.models;
    const availableModels = entries.map((entry) =>
      typeof entry === "string" ? { modelId: entry, name: entry } : entry,
    );
    const hasMeta = availableModels.some((entry) => entry._meta !== undefined);
    const configOptions =
      !Array.isArray(payload) && Array.isArray(payload.configOptions)
        ? payload.configOptions
        : hasMeta
          ? [
              {
                id: "effort",
                name: "Effort",
                category: "thought_level",
                type: "select",
                currentValue: "high",
                options: [
                  { value: "low", name: "Low" },
                  { value: "high", name: "High" },
                ],
              },
            ]
          : undefined;
    send({
      id,
      result: {
        sessionId: "probe-session",
        models: {
          currentModelId: availableModels[0]?.modelId,
          availableModels,
        },
        ...(configOptions === undefined ? {} : { configOptions }),
      },
    });
    send({
      method: "session/update",
      params: {
        sessionId: "probe-session",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    });
  } else {
    send({ id, result: {} });
  }
});
`;

const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(AcpRegistryRuntimeCoordinator.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(driverLayer, { excludeTestServices: true })("AcpRegistryDriver", (it) => {
  it.effect("creates without inspecting the agent, which may fetch the registry", () =>
    Effect.gen(function* () {
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({ status: "unconfigured" }),
          inspect: () => Effect.die("inspected during creation"),
        }),
      );
      expect(yield* instance.snapshot.getSnapshot).toMatchObject({
        installed: false,
        message: "Checking ACP Registry agent readiness...",
      });
    }),
  );

  it.effect(
    "supersedes session-reported models on invalidateCaches when a fresh probe finds models, and preserves them when it finds none",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
        const agentPath = path.join(directory, "agent.mjs");
        const modelsPath = path.join(directory, "models.json");
        yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "other-model"]));
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;

        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: identity.displayName,
          enabled: true,
          environment: [],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
            ...catalogWithInspection({
              status: "ready",
              agentId: "test-agent",
              version: "1.0.0",
              distribution: "npx",
            }),
            resolve: () =>
              Effect.succeed({
                distribution: "npx" as const,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              }),
          }),
        );
        const modelSlugs = instance.snapshot.streamChanges.pipe(
          Stream.map((snapshot) => snapshot.models.map((model) => model.slug)),
        );
        const waitForModels = (expected: ReadonlyArray<string>) =>
          modelSlugs.pipe(
            Stream.filter((slugs) => slugs.join() === expected.join()),
            Stream.runHead,
          );

        const probed = yield* waitForModels(["old-model", "other-model"]).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(probed);
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration(
            [
              {
                id: "legacy",
                name: "Legacy",
                category: "other",
                type: "select",
                currentValue: "on",
                options: [{ value: "on", name: "On" }],
              },
            ],
            undefined,
            {
              currentModelId: "old-model",
              availableModels: [
                { modelId: "old-model", name: "old-model" },
                { modelId: "session-model", name: "session-model" },
              ],
            },
          ),
        );
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify({
            models: ["old-model", "new-model"],
            configOptions: [
              {
                id: "fast",
                name: "Fast",
                category: "other",
                type: "select",
                currentValue: "on",
                options: [
                  { value: "on", name: "On" },
                  { value: "off", name: "Off" },
                ],
              },
            ],
          }),
        );

        const refreshed = yield* waitForModels(["old-model", "new-model"]).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.invalidateCaches ?? Effect.void;
        yield* instance.snapshot.refresh;
        expect(Option.isSome(yield* Fiber.join(refreshed))).toBe(true);

        // A still-running session sending an options-only update after invalidateCaches must still
        // reconcile against the replacement probe's schema (applying fast=off and dropping legacy).
        const sawFastOff = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "old-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "fast")
                ?.currentValue === "off",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          prepareAcpRegistryLiveConfiguration(
            [
              {
                id: "fast",
                name: "Fast",
                category: "other",
                type: "select",
                currentValue: "off",
                options: [
                  { value: "on", name: "On" },
                  { value: "off", name: "Off" },
                ],
              },
              {
                id: "legacy",
                name: "Legacy",
                category: "other",
                type: "select",
                currentValue: "on",
                options: [{ value: "on", name: "On" }],
              },
            ],
            undefined,
            {
              currentModelId: "old-model",
              availableModels: [
                { modelId: "old-model", name: "old-model" },
                { modelId: "session-model", name: "session-model" },
              ],
            },
          ).toLiveConfiguration({ includeCatalog: false }),
        );
        const afterOptions = Option.getOrThrow(yield* Fiber.join(sawFastOff));
        expect(afterOptions.models.map((model) => model.slug)).toEqual(["old-model", "new-model"]);
        expect(
          afterOptions.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([["fast", "off"]]);

        // When a probe returns no models, invalidateCaches + refresh must preserve the running
        // session's catalog instead of dropping to synthetic default.
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "session-x",
            availableModels: [
              { modelId: "session-x", name: "session-x" },
              { modelId: "session-y", name: "session-y" },
            ],
          }),
        );
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify([]));
        const emptyProbeAfterInvalidate = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.invalidateCaches ?? Effect.void;
        yield* instance.snapshot.refresh;
        const afterEmptyProbe = Option.getOrThrow(yield* Fiber.join(emptyProbeAfterInvalidate));
        expect(afterEmptyProbe.models.map((model) => model.slug)).toEqual([
          "session-x",
          "session-y",
        ]);
      }),
  );

  it.effect("keeps a local agent's reported version through the next readiness check", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a"]));

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ source: "local", commandPath: "agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "agent",
            version: null,
            distribution: "local",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "local" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
        }),
      );
      const probed = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.version === "1.5.9"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);

      const nextPublished = yield* instance.snapshot.streamChanges.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      const next = yield* Fiber.join(nextPublished);
      expect(Option.map(next, (snapshot) => snapshot.version)).toEqual(Option.some("1.5.9"));
    }),
  );

  it.effect("keeps options learned for each model across a refresh", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a", "model-b"]));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
        }),
      );
      const effortBySlug = (snapshot: ServerProvider) =>
        snapshot.models
          .map(
            (model) =>
              `${model.slug}:${(model.capabilities?.optionDescriptors ?? []).map((option) => option.id).join("+")}`,
          )
          .join();
      const waitFor = (expected: string) =>
        instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => effortBySlug(snapshot) === expected),
          Stream.runHead,
        );
      const session = (currentModelId: string) =>
        normalizeAcpRegistryLiveConfiguration(
          [
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
          undefined,
          {
            currentModelId,
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-b", name: "model-b" },
            ],
          },
        );

      const probed = yield* waitFor("model-a:,model-b:").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const learned = yield* waitFor("model-a:effort,model-b:effort").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(identity.instanceId, session("model-b"));
      yield* coordinator.publishLiveConfiguration(identity.instanceId, session("model-a"));
      yield* Fiber.join(learned);

      yield* instance.snapshot.refresh;
      expect(effortBySlug(yield* instance.snapshot.getSnapshot)).toBe(
        "model-a:effort,model-b:effort",
      );

      // A reasoning-disabled model keeps its learned model_config options when switching to
      // another model and tweaking shared options.
      const variantLearned = yield* waitFor("model-a:mode+effort,model-b:mode+variant").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        normalizeAcpRegistryLiveConfiguration(
          [
            {
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "ask",
              options: [
                { value: "ask", name: "Ask" },
                { value: "code", name: "Code" },
              ],
            },
            {
              id: "variant",
              name: "Variant",
              category: "model_config",
              type: "select",
              currentValue: "v1",
              options: [{ value: "v1", name: "V1" }],
            },
          ],
          undefined,
          {
            currentModelId: "model-b",
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-b", name: "model-b", _meta: { supportsReasoningEffort: false } },
            ],
          },
        ),
      );
      yield* Fiber.join(variantLearned);

      const modeTweaked = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.models
              .find((model) => model.slug === "model-a")
              ?.capabilities?.optionDescriptors?.find((option) => option.id === "mode")
              ?.currentValue === "code",
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(
          [
            {
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "code",
              options: [
                { value: "ask", name: "Ask" },
                { value: "code", name: "Code" },
              ],
            },
          ],
          undefined,
          {
            currentModelId: "model-a",
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-b", name: "model-b", _meta: { supportsReasoningEffort: false } },
            ],
          },
        ).toLiveConfiguration({ includeCatalog: false }),
      );
      expect(effortBySlug(Option.getOrThrow(yield* Fiber.join(modeTweaked)))).toBe(
        "model-a:mode,model-b:mode+variant",
      );
    }),
  );
});

it.layer(driverLayer)("AcpRegistryDriver periodic refresh", (it) => {
  const readyInspection = {
    status: "ready" as const,
    agentId: "test-agent",
    version: "1.0.0",
    distribution: "npx" as const,
  };

  const setupPeriodicDriver = (options: {
    readonly prefix: string;
    readonly initialModels: unknown;
    readonly wrapCoordinator?: (
      coordinator: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"],
    ) => AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"];
    readonly wrapFileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
    readonly inspect?: () => AcpRegistrySupport.AcpRegistryInspection;
    readonly onResolve?: () => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: options.prefix });
      const statusCacheDir = path.join(directory, "status-cache");
      yield* fileSystem.makeDirectory(statusCacheDir);
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(options.initialModels));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const effectiveCoordinator =
        options.wrapCoordinator === undefined ? coordinator : options.wrapCoordinator(coordinator);
      const effectiveFileSystem =
        options.wrapFileSystem === undefined ? fileSystem : options.wrapFileSystem(fileSystem);
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          paths: {
            ...host.paths,
            providerStatusCacheDir: statusCacheDir,
          },
        }),
        Effect.provideService(FileSystem.FileSystem, effectiveFileSystem),
        Effect.provideService(
          AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
          effectiveCoordinator,
        ),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection(readyInspection),
          inspect: () => Effect.sync(() => (options.inspect ? options.inspect() : readyInspection)),
          resolve: () =>
            (options.onResolve ? options.onResolve() : Effect.void).pipe(
              Effect.as({
                distribution: "npx" as const,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              }),
            ),
        }),
      );
      const waitForEnriched = () =>
        instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
          Stream.runHead,
        );
      const writeModels = (payload: unknown) =>
        fileSystem.writeFileString(modelsPath, JSON.stringify(payload));
      const withBlockedForegroundStartup = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const startup = yield* coordinator
            .withForegroundStartup(
              "test-agent",
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.await(entered);
          const result = yield* body.pipe(
            Effect.ensuring(
              Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(startup))),
            ),
          );
          return result;
        });
      const decodePersistedAuthState = Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ binding: Schema.String, authenticated: Schema.Boolean }),
        ),
      );
      const readPersistedAuthConfirmed = () =>
        Effect.gen(function* () {
          const entries = yield* fileSystem.readDirectory(statusCacheDir);
          const authFile = entries.find(
            (entry) => entry.startsWith("acp-auth-") && entry.endsWith(".json"),
          );
          if (authFile === undefined) return null;
          const contents = yield* fileSystem.readFileString(path.join(statusCacheDir, authFile));
          return (yield* decodePersistedAuthState(contents)).authenticated;
        });
      return {
        directory,
        coordinator,
        instance,
        waitForEnriched,
        writeModels,
        withBlockedForegroundStartup,
        readPersistedAuthConfirmed,
      };
    });

  it.effect(
    "picks up new models on a post-TTL refresh, preserves surviving live option values, and drops removed or disabled options",
    () =>
      Effect.gen(function* () {
        const { coordinator, instance, waitForEnriched, writeModels } = yield* setupPeriodicDriver({
          prefix: "acp-driver-periodic-",
          initialModels: ["old-model", "other-model"],
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(initial)).models.map((model) => model.slug),
        ).toEqual(["old-model", "other-model"]);

        const sessionWithOptions = (
          currentModelId: string,
          effortValue: "low" | "high" | "turbo" = "high",
          options?: { readonly includeCatalog?: boolean; readonly includeLegacy?: boolean },
        ) =>
          prepareAcpRegistryLiveConfiguration(
            [
              {
                id: "effort",
                name: "Effort",
                category: "thought_level",
                type: "select",
                currentValue: effortValue,
                options: [
                  { value: "low", name: "Low" },
                  { value: "high", name: "High" },
                  ...(effortValue === "turbo" ? [{ value: "turbo", name: "Turbo" }] : []),
                ],
              },
              ...(options?.includeLegacy === true
                ? [
                    {
                      id: "legacy",
                      name: "Legacy",
                      category: "other" as const,
                      type: "select" as const,
                      currentValue: "on",
                      options: [{ value: "on", name: "On" }],
                    },
                  ]
                : []),
            ],
            undefined,
            {
              currentModelId,
              availableModels: [
                { modelId: "old-model", name: "old-model" },
                { modelId: "other-model", name: "other-model" },
                ...(currentModelId === "new-model"
                  ? [{ modelId: "new-model", name: "new-model" }]
                  : []),
              ],
            },
          ).toLiveConfiguration(
            options?.includeCatalog === undefined
              ? undefined
              : { includeCatalog: options.includeCatalog },
          );
        const learnedEffort = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "old-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
                ?.currentValue === "low" &&
              snapshot.models
                .find((model) => model.slug === "other-model")
                ?.capabilities?.optionDescriptors?.some((option) => option.id === "effort") ===
                true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          sessionWithOptions("other-model", "high", { includeLegacy: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          sessionWithOptions("old-model", "low", { includeLegacy: true }),
        );
        yield* Fiber.join(learnedEffort);

        // Upstream adds a model and a probe-only shared option (fast), removes the shared legacy
        // option, and disables reasoning on other-model.
        yield* writeModels({
          models: [
            "new-model",
            "old-model",
            {
              modelId: "other-model",
              name: "other-model",
              _meta: { supportsReasoningEffort: false },
            },
          ],
          configOptions: [
            {
              id: "fast",
              name: "Fast",
              category: "other",
              type: "select",
              currentValue: "on",
              options: [{ value: "on", name: "On" }],
            },
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
        });
        yield* TestClock.adjust("16 minutes");

        const postTtl = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const updated = Option.getOrThrow(yield* Fiber.join(postTtl));
        expect(updated.models.map((model) => model.slug)).toEqual([
          "new-model",
          "old-model",
          "other-model",
        ]);
        // old-model keeps its live effort value (low) alongside probe-only fast=on while legacy is dropped.
        expect(
          updated.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["fast", "on"],
          ["effort", "low"],
        ]);
        expect(
          updated.models
            .find((model) => model.slug === "other-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]) ??
            [],
        ).toEqual([["fast", "on"]]);
        expect(
          updated.models
            .find((model) => model.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]) ??
            [],
        ).toEqual([
          ["fast", "on"],
          ["effort", "high"],
        ]);
        // Coordinator retains live option values (with models stripped) for Copilot unsetOptionDefaults.
        expect(
          Option.map(yield* coordinator.getLiveConfiguration(identity.instanceId), (config) => ({
            models: config.models,
            effort: config.configOptions.find((option) => option.id === "effort")?.currentValue,
          })),
        ).toEqual(Option.some({ models: [], effort: "low" }));

        // A mid-session options-only update from the older superseded session (lacking probe-only
        // fast and still carrying removed legacy) keeps the new catalog, keeps fast=on, and drops legacy.
        const effortUpdated = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "old-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
                ?.currentValue === "high",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          sessionWithOptions("old-model", "high", { includeCatalog: false, includeLegacy: true }),
        );
        const afterSupersededOptions = Option.getOrThrow(yield* Fiber.join(effortUpdated));
        expect(afterSupersededOptions.models.map((model) => model.slug)).toEqual([
          "new-model",
          "old-model",
          "other-model",
        ]);
        expect(
          afterSupersededOptions.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["fast", "on"],
          ["effort", "high"],
        ]);
        expect(
          afterSupersededOptions.models
            .find((model) => model.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["fast", "on"],
          ["effort", "high"],
        ]);

        // Cached refresh must reuse the cached catalog and probe-only options without re-probing.
        yield* writeModels(["unexpected-reprobe", "other-model"]);
        const nextCached = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const cachedAfterSuperseded = Option.getOrThrow(yield* Fiber.join(nextCached));
        expect(cachedAfterSuperseded.models.map((model) => model.slug)).toEqual([
          "new-model",
          "old-model",
          "other-model",
        ]);
        expect(
          cachedAfterSuperseded.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["fast", "on"],
          ["effort", "high"],
        ]);

        // If a superseded session overrides new-model's effort to low and later reports an
        // invalid value (turbo), both snapshot and cached refresh restore the probe default (high).
        const newModelLow = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "new-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
                ?.currentValue === "low",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          sessionWithOptions("new-model", "low", { includeCatalog: false }),
        );
        yield* Fiber.join(newModelLow);

        const restoredBaseline = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "new-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
                ?.currentValue === "high",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          sessionWithOptions("new-model", "turbo", { includeCatalog: false }),
        );
        const afterRejectedOverride = Option.getOrThrow(yield* Fiber.join(restoredBaseline));
        expect(
          afterRejectedOverride.models
            .find((model) => model.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["fast", "on"],
          ["effort", "high"],
        ]);
        const cachedAfterRejection = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(cachedAfterRejection))
            .models.find((model) => model.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["fast", "on"],
          ["effort", "high"],
        ]);

        // When a later post-TTL probe runs directly on old-model without effort, learned effort is dropped.
        yield* writeModels(["old-model", "new-model"]);
        yield* TestClock.adjust("16 minutes");
        const droppedOnCurrent = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const currentObserved = Option.getOrThrow(yield* Fiber.join(droppedOnCurrent));
        expect(currentObserved.models.map((model) => model.slug)).toEqual([
          "old-model",
          "new-model",
        ]);
        expect(
          currentObserved.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
        ).toEqual([]);
      }),
  );

  it.effect(
    "retains accepted models across provisional probes while retrying on the short provisional TTL",
    () =>
      Effect.gen(function* () {
        const { coordinator, instance, waitForEnriched, writeModels } = yield* setupPeriodicDriver({
          prefix: "acp-driver-provisional-",
          initialModels: ["new-model", "old-model", "other-model"],
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        const liveCatalogApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.models.map((m) => m.slug).join() === "live-a,live-b",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "live-a", name: "Live A", description: null },
            { id: "live-b", name: "Live B", description: null },
          ],
          currentModelId: "live-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(liveCatalogApplied);

        yield* writeModels({ provisional: "placeholder" });
        yield* TestClock.adjust("16 minutes");
        const afterProvisional = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(afterProvisional)).models.map((model) => model.slug),
        ).toEqual(["live-a", "live-b"]);

        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "live-a",
          configOptions: [],
          modelsFromModelSelect: false,
        });
        // Switch fixture to a winning multi-model catalog so a cache miss would diverge from live-a/live-b.
        yield* writeModels(["unexpected-reprobe", "other-model"]);
        const cachedWithinRetryTtl = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(cachedWithinRetryTtl)).models.map(
            (model) => model.slug,
          ),
        ).toEqual(["live-a", "live-b"]);

        // After the 30s provisional retry TTL expires, refresh re-probes and adopts the settled catalog.
        yield* writeModels(["new-model", "old-model", "other-model", "settled-model"]);
        yield* TestClock.adjust("1 minute");
        const afterProvisionalRetry = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(afterProvisionalRetry)).models.map(
            (model) => model.slug,
          ),
        ).toEqual(["new-model", "old-model", "other-model", "settled-model"]);
      }),
  );

  it.effect(
    "preserves transient discovery warnings across options-only updates and ignores live updates when not installed",
    () =>
      Effect.gen(function* () {
        let inspectHandler = (): AcpRegistrySupport.AcpRegistryInspection => readyInspection;
        const uninstalledLiveProcessed = yield* Deferred.make<void>();
        let trackNextLiveUpdate = false;
        const {
          coordinator,
          instance,
          waitForEnriched,
          writeModels,
          withBlockedForegroundStartup,
        } = yield* setupPeriodicDriver({
          prefix: "acp-driver-warning-",
          initialModels: ["new-model", "old-model", "other-model"],
          inspect: () => inspectHandler(),
          wrapCoordinator: (base) => ({
            ...base,
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) =>
                  onUpdate(configuration, revision).pipe(
                    Effect.tap(() =>
                      trackNextLiveUpdate
                        ? Deferred.succeed(uninstalledLiveProcessed, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
                options,
              ),
          }),
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        const effortOption = (currentValue: "low" | "high") => ({
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue,
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        });
        const optionsBeforeFailure = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "old-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
                ?.currentValue === "low",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "old-model",
          configOptions: [effortOption("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(optionsBeforeFailure);

        yield* writeModels({ fail: "Temporary discovery outage" });
        yield* TestClock.adjust("16 minutes");
        const failedProbe = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "warning"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const warned = Option.getOrThrow(yield* Fiber.join(failedProbe));
        expect(warned.status).toBe("warning");
        expect(warned.message).toBeTruthy();
        expect(warned.models.map((model) => model.slug)).toEqual([
          "new-model",
          "old-model",
          "other-model",
        ]);
        expect(
          warned.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
            ?.currentValue,
        ).toBe("low");

        // A subsequent options-only update must keep the transient warning status and message.
        const updatedWhileWarned = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "old-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
                ?.currentValue === "high",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "old-model",
          configOptions: [effortOption("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        const stillWarned = Option.getOrThrow(yield* Fiber.join(updatedWhileWarned));
        expect(stillWarned.status).toBe("warning");
        expect(stillWarned.message).toBe(warned.message);

        // If re-inspection during enrichment reports the agent is not installed while the
        // live watcher is still running, a live options-only update must neither flip status
        // to ready nor overwrite acceptedCatalog with default.
        const notFoundInspection: AcpRegistrySupport.AcpRegistryInspection = {
          status: "not_found",
          agentId: "test-agent",
        };
        yield* TestClock.adjust("16 minutes");
        const uninstalled = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => !snapshot.installed),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        // First inspect is checkProvider (ready, so watcher stays active); second is enrichProvider (not_found).
        let inspectCalls = 0;
        inspectHandler = () => (++inspectCalls === 1 ? readyInspection : notFoundInspection);
        yield* instance.snapshot.refresh;
        const uninstalledSnap = Option.getOrThrow(yield* Fiber.join(uninstalled));
        expect(uninstalledSnap.installed).toBe(false);
        expect(uninstalledSnap.status).toBe("error");

        // Publish an options-only update while the watcher is active on the uninstalled snapshot.
        trackNextLiveUpdate = true;
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "old-model",
          configOptions: [effortOption("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* Deferred.await(uninstalledLiveProcessed);
        trackNextLiveUpdate = false;
        const afterUninstalledLive = yield* instance.snapshot.getSnapshot;
        expect(afterUninstalledLive.installed).toBe(false);
        expect(afterUninstalledLive.status).toBe("error");
        expect(afterUninstalledLive.models).toEqual(uninstalledSnap.models);

        // Direct readiness refresh while not_found also stays error/uninstalled despite live config.
        inspectHandler = () => notFoundInspection;
        yield* instance.snapshot.refresh;
        const directNotFound = yield* instance.snapshot.getSnapshot;
        expect(directNotFound.installed).toBe(false);
        expect(directNotFound.status).toBe("error");

        // Once installed again, acceptedCatalog still has the multi-model list during foreground startup.
        inspectHandler = () => readyInspection;
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.snapshot.refresh;
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "new-model",
              "old-model",
              "other-model",
            ]);
          }),
        );
      }),
  );

  it.effect(
    "seeds reset revision on rebuild, accepts live catalogs while unauthenticated, and clears accepted state on sign-out, invalidation, and provider disable",
    () =>
      Effect.gen(function* () {
        const signOutRejected = yield* Deferred.make<void>();
        let pendingResolveGate: {
          readonly entered: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        let pendingLiveWatch: {
          readonly minRevision: number;
          readonly done: Deferred.Deferred<void>;
        } | null = null;
        let injectModeAfterInitialClear = true;
        let injectCatalogBeforeSignOutClear = false;
        const awaitLiveWatchUpdate = (publish: Effect.Effect<void>) =>
          Effect.gen(function* () {
            const beforeRevision = (yield* coordinator.getLiveConfigurationWithRevision(
              identity.instanceId,
            )).revision;
            const done = yield* Deferred.make<void>();
            pendingLiveWatch = { minRevision: beforeRevision + 1, done };
            yield* publish;
            yield* Deferred.await(done);
          });
        // A brand-new driver starts signed in (not signed out), so pre-probe readiness
        // replays options-only updates published while foreground startup blocks the first probe.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const preProbe = yield* setupPeriodicDriver({
              prefix: "acp-driver-preprobe-",
              initialModels: ["new-model", "old-model"],
            });
            yield* preProbe.coordinator.publishLiveConfiguration(identity.instanceId, {
              models: [],
              currentModelId: null,
              configOptions: [
                {
                  id: "pre-probe",
                  label: "Pre-probe",
                  type: "boolean",
                  currentValue: true,
                },
              ],
              modelOptionIds: [],
              modelsFromModelSelect: false,
            });
            yield* preProbe.withBlockedForegroundStartup(
              Effect.gen(function* () {
                yield* preProbe.instance.snapshot.refresh;
                expect(
                  (yield* preProbe.instance.snapshot
                    .getSnapshot).models[0]?.capabilities?.optionDescriptors?.map((d) => d.id),
                ).toContain("pre-probe");
              }),
            );
          }),
        );
        // Pre-populate the shared coordinator before create() to simulate a rebuilt driver instance:
        // create() must seed liveSessionResetRevision from its clear so the first probe does not
        // treat the prior instance's cleared publications as an active superseded live session.
        const sharedCoordinator =
          yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        yield* sharedCoordinator.publishLiveConfiguration(identity.instanceId, {
          models: [{ id: "prior-instance-model", name: "Prior Instance Model", description: null }],
          currentModelId: "prior-instance-model",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        const {
          directory,
          coordinator,
          instance,
          waitForEnriched,
          writeModels,
          withBlockedForegroundStartup,
        } = yield* setupPeriodicDriver({
          prefix: "acp-driver-clear-",
          initialModels: ["new-model", "old-model", "other-model"],
          wrapCoordinator: (base) => ({
            ...base,
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) =>
                  onUpdate(configuration, revision).pipe(
                    Effect.tap(() => {
                      const pending = pendingLiveWatch;
                      if (pending === null || revision < pending.minRevision) return Effect.void;
                      pendingLiveWatch = null;
                      return Deferred.succeed(pending.done, undefined).pipe(Effect.asVoid);
                    }),
                  ),
                options,
              ),
            clearLiveConfigurationIfRevision: (instanceId, options) =>
              Effect.gen(function* () {
                if (injectCatalogBeforeSignOutClear && options.retain === undefined) {
                  injectCatalogBeforeSignOutClear = false;
                  yield* base.publishLiveConfiguration(instanceId, {
                    models: [
                      { id: "raced-auth-a", name: "Raced Auth A", description: null },
                      { id: "raced-auth-b", name: "Raced Auth B", description: null },
                    ],
                    currentModelId: "raced-auth-a",
                    configOptions: [],
                    modelsFromModelSelect: true,
                  });
                  const cleared = yield* base.clearLiveConfigurationIfRevision(instanceId, options);
                  yield* Deferred.succeed(signOutRejected, undefined);
                  return cleared;
                }
                const cleared = yield* base.clearLiveConfigurationIfRevision(instanceId, options);
                // Publish an options-only update right after the clear returns to verify
                // supersession uses the watermark returned by the clear rather than the post-clear
                // live revision.
                if (
                  Option.isSome(cleared) &&
                  injectModeAfterInitialClear &&
                  options.retain !== undefined
                ) {
                  injectModeAfterInitialClear = false;
                  yield* base.publishLiveConfiguration(instanceId, {
                    models: [],
                    currentModelId: null,
                    configOptions: [
                      {
                        id: "mode",
                        label: "Mode",
                        type: "select",
                        currentValue: "plan",
                        options: [
                          { id: "plan", label: "Plan" },
                          { id: "code", label: "Code" },
                        ],
                      },
                    ],
                    modelOptionIds: [],
                    modelsFromModelSelect: false,
                  });
                }
                return cleared;
              }),
          }),
          onResolve: () =>
            Effect.gen(function* () {
              const gate = pendingResolveGate;
              if (gate !== null) {
                pendingResolveGate = null;
                yield* Deferred.succeed(gate.entered, undefined);
                yield* Deferred.await(gate.release);
              }
            }),
        });

        // Neither the prior instance's cleared state nor an options-only publish arriving right
        // after the clear should mark the rebuilt driver's first probe as superseding a live session.
        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const initialSnap = Option.getOrThrow(yield* Fiber.join(initial));
        expect(
          initialSnap.models
            .find((m) => m.slug === "new-model")
            ?.capabilities?.optionDescriptors?.find((d) => d.id === "mode")?.currentValue,
        ).toBe("plan");
        const sawPostStartModeUpdate = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "new-model")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "mode")?.currentValue ===
              "code",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: null,
          configOptions: [
            {
              id: "mode",
              label: "Mode",
              type: "select",
              currentValue: "code",
              options: [
                { id: "plan", label: "Plan" },
                { id: "code", label: "Code" },
              ],
            },
          ],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        expect(Option.isSome(yield* Fiber.join(sawPostStartModeUpdate))).toBe(true);

        // Unauthenticated post-TTL probe racing an options-only live update must still keep
        // status: warning, auth: unauthenticated, sign-in message, and models: ["default"].
        yield* writeModels({ fail: "Sign in required", code: -32000 });
        yield* TestClock.adjust("16 minutes");
        const authProbeEntered = yield* Deferred.make<void>();
        const releaseAuthProbe = yield* Deferred.make<void>();
        pendingResolveGate = { entered: authProbeEntered, release: releaseAuthProbe };
        const signedOutProbe = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(authProbeEntered);

        const optionsDuringAuthProbe = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "old-model")
                ?.capabilities?.optionDescriptors?.some((option) => option.id === "effort") ===
              true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "old-model",
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "low",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(optionsDuringAuthProbe);

        yield* Deferred.succeed(releaseAuthProbe, undefined);
        const signedOut = Option.getOrThrow(yield* Fiber.join(signedOutProbe));
        expect(signedOut.status).toBe("warning");
        expect(signedOut.auth.status).toBe("unauthenticated");
        expect(signedOut.message).toBeTruthy();
        expect(signedOut.models.map((model) => model.slug)).toEqual(["default"]);
        expect(Option.isNone(yield* coordinator.getLiveConfiguration(identity.instanceId))).toBe(
          true,
        );

        // Subsequent readiness refresh during foreground startup stays on default instead of flipping back.
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.snapshot.refresh;
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "default",
            ]);
          }),
        );

        // Re-populate the catalog AND live coordinator state, then verify disableProvider clears
        // both coordinator state and acceptedCatalog so a provisional probe does not retain old models.
        yield* writeModels(["new-model", "old-model", "other-model"]);
        const restored = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(restored);

        // Sign-out advanced liveSessionResetRevision to the cleared watermark, so a fresh
        // options-only update on the re-authenticated probe is accepted rather than filtered
        // against an empty probe schema.
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "new-model",
            configOptions: [
              {
                id: "fresh-after-signout",
                label: "Fresh After Signout",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["fresh-after-signout"],
            modelsFromModelSelect: false,
          }),
        );
        expect(
          (yield* instance.snapshot.getSnapshot).models
            .find((m) => m.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toContain("fresh-after-signout");

        const liveBeforeDisable = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models.map((m) => m.slug).join() === "live-disable-a,live-disable-b",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "live-disable-a", name: "Live Disable A", description: null },
            { id: "live-disable-b", name: "Live Disable B", description: null },
          ],
          currentModelId: "live-disable-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(liveBeforeDisable);
        expect(Option.isSome(yield* coordinator.getLiveConfiguration(identity.instanceId))).toBe(
          true,
        );

        yield* instance.acpSessionManagement!.disableProvider({
          cwd: directory,
          providerId: "old-provider",
        });
        expect(Option.isNone(yield* coordinator.getLiveConfiguration(identity.instanceId))).toBe(
          true,
        );
        yield* writeModels({ provisional: "placeholder" });
        const afterDisable = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(afterDisable)).models.map((model) => model.slug),
        ).toEqual(["placeholder"]);

        // Re-populate, then verify invalidateCaches and auth.invalidate clear both coordinator and acceptedCatalog.
        yield* writeModels(["new-model", "old-model", "other-model"]);
        yield* TestClock.adjust("1 minute");
        const restored2 = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(restored2);

        // disableProvider advanced liveSessionResetRevision to the cleared watermark, so a fresh
        // options-only update on the new probe is accepted rather than filtered against the probe's
        // empty option schema.
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "new-model",
            configOptions: [
              {
                id: "fresh-after-disable",
                label: "Fresh After Disable",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["fresh-after-disable"],
            modelsFromModelSelect: false,
          }),
        );
        expect(
          (yield* instance.snapshot.getSnapshot).models
            .find((m) => m.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toContain("fresh-after-disable");

        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.snapshot.refresh;
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "new-model",
              "old-model",
              "other-model",
            ]);
            yield* instance.invalidateCaches ?? Effect.void;
            yield* instance.snapshot.refresh;
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "default",
            ]);
          }),
        );

        // When only an earlier preserveDefault entry remains in pendingOptions (configuration is
        // None), invalidateCaches + refresh must keep probeOptions active so the retained override
        // survives and later stale live options are still filtered against the new probe schema.
        yield* writeModels({
          models: ["new-model", "old-model"],
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "new-model",
              options: [
                { value: "new-model", name: "New Model" },
                { value: "old-model", name: "Old Model" },
              ],
            },
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
        });
        const withEffortProbe = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(withEffortProbe);

        const sawPendingOverride = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.models.find((m) => m.slug === "new-model")?.isDefault === true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "old-model",
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "low",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "new-model",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(sawPendingOverride);

        yield* TestClock.adjust("16 minutes");
        const clearedToPendingOnly = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(clearedToPendingOnly);
        expect(Option.isNone(yield* coordinator.getLiveConfiguration(identity.instanceId))).toBe(
          true,
        );
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(identity.instanceId)).pendingOptions
            .length,
        ).toBeGreaterThan(0);

        yield* instance.invalidateCaches ?? Effect.void;
        const afterInvalidatePendingOnly = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const invalidatedSnap = Option.getOrThrow(yield* Fiber.join(afterInvalidatePendingOnly));
        expect(
          invalidatedSnap.models
            .find((m) => m.slug === "old-model")
            ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue,
        ).toBe("low");

        const sawFilteredLegacy = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "new-model")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
              "low",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "new-model",
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "low",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
            {
              id: "legacy",
              label: "Legacy",
              type: "boolean",
              currentValue: true,
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        const filteredSnap = Option.getOrThrow(yield* Fiber.join(sawFilteredLegacy));
        expect(
          filteredSnap.models.map((m) => [
            m.slug,
            (m.capabilities?.optionDescriptors ?? []).map((d) => d.id),
          ]),
        ).toEqual([
          ["new-model", ["effort"]],
          ["old-model", ["effort"]],
        ]);

        // Even when a superseding probe after invalidateCaches drops the last pending override
        // (leaving pendingOptions empty and configuration None), probeOptions must remain stored
        // so later options-only updates from the old session still filter out stale options.
        yield* writeModels({
          models: [
            { modelId: "replaced-model-a", name: "Replaced Model A" },
            { modelId: "replaced-model-b", name: "Replaced Model B" },
          ],
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "replaced-model-a",
              options: [
                { value: "replaced-model-a", name: "Replaced Model A" },
                { value: "replaced-model-b", name: "Replaced Model B" },
              ],
            },
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
        });
        yield* instance.invalidateCaches ?? Effect.void;
        const droppedLastOverride = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(droppedLastOverride);
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(identity.instanceId)).pendingOptions,
        ).toEqual([]);

        // A second invalidateCaches + probe with zero pending overrides left still remembers the
        // superseded live session and filters legacy options on subsequent live updates.
        yield* instance.invalidateCaches ?? Effect.void;
        const secondEmptyClear = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(secondEmptyClear);

        const sawStillFilteredLegacy = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "replaced-model-a")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
              "low",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "replaced-model-a",
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "low",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
            {
              id: "legacy",
              label: "Legacy",
              type: "boolean",
              currentValue: true,
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        const stillFilteredSnap = Option.getOrThrow(yield* Fiber.join(sawStillFilteredLegacy));
        expect(
          stillFilteredSnap.models.map((m) => [
            m.slug,
            (m.capabilities?.optionDescriptors ?? []).map((d) => d.id),
          ]),
        ).toEqual([
          ["replaced-model-a", ["effort"]],
          ["replaced-model-b", []],
        ]);
        yield* writeModels(["new-model", "old-model", "other-model"]);
        yield* TestClock.adjust("16 minutes");

        const restoredForAuthInvalidate = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(restoredForAuthInvalidate);
        const liveBeforeAuthInvalidate = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.models.map((m) => m.slug).join() === "live-auth-a,live-auth-b",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "live-auth-a", name: "Live Auth A", description: null },
            { id: "live-auth-b", name: "Live Auth B", description: null },
          ],
          currentModelId: "live-auth-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(liveBeforeAuthInvalidate);
        expect(Option.isSome(yield* coordinator.getLiveConfiguration(identity.instanceId))).toBe(
          true,
        );
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.auth?.invalidate ?? Effect.void;
            expect(
              Option.isNone(yield* coordinator.getLiveConfiguration(identity.instanceId)),
            ).toBe(true);
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "default",
            ]);
          }),
        );

        // If a newer live catalog lands right before an unauthenticated probe clears
        // coordinator state, clearLiveConfigurationIfRevision returns Option.none() and the stale
        // sign-out warning must be discarded rather than overwriting the new catalog.
        yield* writeModels({ fail: "Sign in required", code: -32000 });
        injectCatalogBeforeSignOutClear = true;
        const racedLiveApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.models.map((m) => m.slug).join() === "raced-auth-a,raced-auth-b",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(signOutRejected);
        const racedSnap = Option.getOrThrow(yield* Fiber.join(racedLiveApplied));
        expect(racedSnap.status).toBe("ready");
        expect(racedSnap.auth.status).not.toBe("unauthenticated");
        expect(Option.isSome(yield* coordinator.getLiveConfiguration(identity.instanceId))).toBe(
          true,
        );
        // The discarded sign-out probe must not mark the driver signed out, so an
        // options-only update on the raced catalog is still applied by the watcher.
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "raced-auth-b",
            configOptions: [
              {
                id: "after-raced-signout",
                label: "After Raced Signout",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["after-raced-signout"],
            modelsFromModelSelect: false,
          }),
        );
        expect(
          (yield* instance.snapshot.getSnapshot).models
            .find((m) => m.slug === "raced-auth-b")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toContain("after-raced-signout");

        // An options-only update arriving while unauthenticated must be ignored by the watcher.
        yield* TestClock.adjust("16 minutes");
        const signedOutForWatcher = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const unauthSnap = Option.getOrThrow(yield* Fiber.join(signedOutForWatcher));
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: null,
            configOptions: [
              {
                id: "mode",
                label: "Mode",
                type: "select",
                currentValue: "plan",
                options: [{ id: "plan", label: "Plan" }],
              },
            ],
            modelOptionIds: [],
            modelsFromModelSelect: false,
          }),
        );
        expect((yield* instance.snapshot.getSnapshot).models).toEqual(unauthSnap.models);

        // A full live catalog arriving while unauthenticated must still apply and be saved to
        // acceptedCatalog, and a follow-up non-replacing single-model update while auth status is
        // still unauthenticated must also persist in acceptedCatalog across readiness refreshes.
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [
              { id: "unauth-live-a", name: "Unauth Live A", description: null },
              { id: "unauth-live-b", name: "Unauth Live B", description: null },
            ],
            currentModelId: "unauth-live-a",
            configOptions: [],
            modelsFromModelSelect: true,
          }),
        );
        expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
          "unauth-live-a",
          "unauth-live-b",
        ]);
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [{ id: "unauth-live-a", name: "Unauth Live A", description: null }],
            currentModelId: "unauth-live-a",
            configOptions: [
              {
                id: "unauth-live-opt",
                label: "Unauth Live Opt",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["unauth-live-opt"],
            modelsFromModelSelect: false,
          }),
        );
        const snapAfterNonReplacingUnauth = yield* instance.snapshot.getSnapshot;
        expect(snapAfterNonReplacingUnauth.auth.status).toBe("unauthenticated");
        expect(
          snapAfterNonReplacingUnauth.models
            .find((m) => m.slug === "unauth-live-a")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toEqual(["unauth-live-opt"]);
        yield* coordinator.clearLiveConfiguration(identity.instanceId);
        // Signed-out readiness must keep the saved catalog and its saved non-replacing update
        // without replaying options-only updates, and the watcher must keep ignoring options-only
        // updates even after readiness resets auth status to "unknown".
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: null,
            configOptions: [
              {
                id: "mode",
                label: "Mode",
                type: "select",
                currentValue: "plan",
                options: [
                  { id: "plan", label: "Plan" },
                  { id: "code", label: "Code" },
                ],
              },
            ],
            modelOptionIds: [],
            modelsFromModelSelect: false,
          }),
        );
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.snapshot.refresh;
            const readinessWhileSignedOut = yield* instance.snapshot.getSnapshot;
            expect(readinessWhileSignedOut.auth.status).toBe("unknown");
            expect(readinessWhileSignedOut.models.map((m) => m.slug)).toEqual([
              "unauth-live-a",
              "unauth-live-b",
            ]);
            expect(
              readinessWhileSignedOut.models
                .find((m) => m.slug === "unauth-live-a")
                ?.capabilities?.optionDescriptors?.map((d) => d.id),
            ).toEqual(["unauth-live-opt"]);
            expect(
              readinessWhileSignedOut.models.find((m) => m.slug === "unauth-live-b")?.capabilities
                ?.optionDescriptors ?? [],
            ).toEqual([]);
          }),
        );
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: null,
            configOptions: [
              {
                id: "mode",
                label: "Mode",
                type: "select",
                currentValue: "code",
                options: [
                  { id: "plan", label: "Plan" },
                  { id: "code", label: "Code" },
                ],
              },
            ],
            modelOptionIds: [],
            modelsFromModelSelect: false,
          }),
        );
        const snapAfterBlockedWatcherOption = yield* instance.snapshot.getSnapshot;
        expect(
          snapAfterBlockedWatcherOption.models
            .find((m) => m.slug === "unauth-live-a")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toEqual(["unauth-live-opt"]);
        expect(
          snapAfterBlockedWatcherOption.models.find((m) => m.slug === "unauth-live-b")?.capabilities
            ?.optionDescriptors ?? [],
        ).toEqual([]);

        // Confirmed sign-in (auth.onChanged(true)) clears the signed-out restriction so readiness
        // immediately replays pending options-only updates before enrichment finishes.
        yield* writeModels(["new-model", "old-model"]);
        const sawAuthenticatedReadiness = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.nativeSessions === undefined),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const postSignInEnriched = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.auth!.start("owner", Effect.void, "agent-login");
        const authenticatedReadiness = Option.getOrThrow(
          yield* Fiber.join(sawAuthenticatedReadiness),
        );
        expect(authenticatedReadiness.auth.status).toBe("authenticated");
        expect(
          authenticatedReadiness.models
            .find((m) => m.slug === "unauth-live-a")
            ?.capabilities?.optionDescriptors?.find((d) => d.id === "mode")?.currentValue,
        ).toBe("code");
        yield* Fiber.join(postSignInEnriched);
      }),
  );

  it.effect(
    "serializes sign-in confirmation and reopens pending options on ready-probe races without reopening on resets or transient failures",
    () =>
      Effect.gen(function* () {
        const readyRaceRejected = yield* Deferred.make<void>();
        let pendingResolveGate: {
          readonly entered: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        let pendingAuthPersistGate: {
          readonly entered: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        let blockLiveWatch: Deferred.Deferred<void> | null = null;
        let pendingCommitEntered: Deferred.Deferred<void> | null = null;
        let pendingLiveWatch: {
          readonly minRevision: number;
          readonly done: Deferred.Deferred<void>;
        } | null = null;
        let injectCatalogBeforeReadyClear = false;
        const {
          directory,
          coordinator,
          instance,
          waitForEnriched,
          writeModels,
          withBlockedForegroundStartup,
          readPersistedAuthConfirmed,
        } = yield* setupPeriodicDriver({
          prefix: "acp-driver-auth-reopen-",
          initialModels: ["new-model", "old-model"],
          wrapFileSystem: (base) => ({
            ...base,
            rename: (oldPath, newPath) =>
              Effect.gen(function* () {
                const gate = pendingAuthPersistGate;
                if (gate !== null && newPath.includes("acp-auth-")) {
                  const contents = yield* base.readFileString(oldPath);
                  if (contents.includes('"authenticated":true')) {
                    pendingAuthPersistGate = null;
                    yield* Deferred.succeed(gate.entered, undefined);
                    yield* Deferred.await(gate.release);
                  }
                }
                return yield* base.rename(oldPath, newPath);
              }),
          }),
          wrapCoordinator: (base) => ({
            ...base,
            getLiveConfigurationWithRevision: (instanceId) =>
              base.getLiveConfigurationWithRevision(instanceId).pipe(
                Effect.tap(() => {
                  const done = pendingCommitEntered;
                  if (done === null) return Effect.void;
                  pendingCommitEntered = null;
                  return Deferred.succeed(done, undefined).pipe(Effect.asVoid);
                }),
              ),
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) =>
                  (blockLiveWatch !== null ? Deferred.await(blockLiveWatch) : Effect.void).pipe(
                    Effect.andThen(onUpdate(configuration, revision)),
                    Effect.tap(() => {
                      const pending = pendingLiveWatch;
                      if (pending === null || revision < pending.minRevision) return Effect.void;
                      pendingLiveWatch = null;
                      return Deferred.succeed(pending.done, undefined).pipe(Effect.asVoid);
                    }),
                  ),
                options,
              ),
            clearLiveConfigurationIfRevision: (instanceId, options) =>
              Effect.gen(function* () {
                if (injectCatalogBeforeReadyClear && options.retain !== undefined) {
                  injectCatalogBeforeReadyClear = false;
                  yield* base.publishLiveConfiguration(instanceId, {
                    models: [
                      { id: "raced-ready-a", name: "Raced Ready A", description: null },
                      { id: "raced-ready-b", name: "Raced Ready B", description: null },
                    ],
                    currentModelId: "raced-ready-a",
                    configOptions: [],
                    modelsFromModelSelect: true,
                  });
                  const cleared = yield* base.clearLiveConfigurationIfRevision(instanceId, options);
                  yield* Deferred.succeed(readyRaceRejected, undefined);
                  return cleared;
                }
                return yield* base.clearLiveConfigurationIfRevision(instanceId, options);
              }),
          }),
          onResolve: () =>
            Effect.gen(function* () {
              const gate = pendingResolveGate;
              if (gate !== null) {
                pendingResolveGate = null;
                yield* Deferred.succeed(gate.entered, undefined);
                yield* Deferred.await(gate.release);
              }
            }),
        });
        const awaitLiveWatchUpdate = (publish: Effect.Effect<void>) =>
          Effect.gen(function* () {
            const beforeRevision = (yield* coordinator.getLiveConfigurationWithRevision(
              identity.instanceId,
            )).revision;
            const done = yield* Deferred.make<void>();
            pendingLiveWatch = { minRevision: beforeRevision + 1, done };
            yield* publish;
            yield* Deferred.await(done);
          });
        const runGatedProbe = <E>(duringProbe: Effect.Effect<void, E>) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            pendingResolveGate = { entered, release };
            yield* instance.snapshot.refresh;
            yield* Deferred.await(entered);
            yield* duringProbe;
            // Resolves on commitEnrichment's coordinator read while it holds liveSnapshotSemaphore,
            // so the watcher handles the caller's follow-up publish only after commit finishes.
            const commitEntered = yield* Deferred.make<void>();
            pendingCommitEntered = commitEntered;
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(commitEntered);
          });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(Option.getOrThrow(yield* Fiber.join(initial)).auth.status).toBe("unknown");
        expect(yield* readPersistedAuthConfirmed()).toBeNull();

        // Confirmed sign-in invalidates a still-valid enrichment cache so the post-sign-in refresh
        // probes newly available models instead of serving stale cached entries, and persists
        // sign-in confirmation.
        yield* writeModels(["post-signin-a", "post-signin-b"]);
        const postCacheInvalidatingSignIn = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.auth!.start("owner", Effect.void, "agent-login");
        const postCacheInvalidatingSnap = Option.getOrThrow(
          yield* Fiber.join(postCacheInvalidatingSignIn),
        );
        expect(postCacheInvalidatingSnap.models.map((m) => m.slug)).toEqual([
          "post-signin-a",
          "post-signin-b",
        ]);
        expect(postCacheInvalidatingSnap.auth.status).toBe("authenticated");
        expect(yield* readPersistedAuthConfirmed()).toBe(true);

        // auth.invalidate clears persisted sign-in confirmation so readiness falls back to unknown.
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.auth!.invalidate!;
            expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unknown");
            expect(yield* readPersistedAuthConfirmed()).toBe(false);
          }),
        );

        // onChanged(true) holds liveSnapshotSemaphore while persisting sign-in confirmation so
        // concurrent snapshot mutations (like an older unauthenticated commit or cache reset)
        // cannot interleave and clobber confirmed auth.
        const authPersistEntered = yield* Deferred.make<void>();
        const releaseAuthPersist = yield* Deferred.make<void>();
        pendingAuthPersistGate = { entered: authPersistEntered, release: releaseAuthPersist };
        const sawSerializedSignIn = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.nativeSessions === undefined),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.auth!.start("owner", Effect.void, "agent-login");
        yield* Deferred.await(authPersistEntered);
        let invalidateCompletedWhilePersistingAuth = false;
        const concurrentInvalidateFiber = yield* instance.invalidateCaches!.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              invalidateCompletedWhilePersistingAuth = true;
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.sync(() => {
          expect(invalidateCompletedWhilePersistingAuth).toBe(false);
        }).pipe(Effect.ensuring(Deferred.succeed(releaseAuthPersist, undefined)));
        yield* Fiber.join(concurrentInvalidateFiber);
        expect(invalidateCompletedWhilePersistingAuth).toBe(true);
        expect(Option.getOrThrow(yield* Fiber.join(sawSerializedSignIn)).auth.status).toBe(
          "authenticated",
        );
        expect(yield* readPersistedAuthConfirmed()).toBe(true);

        // Explicit sign-out (auth.logout -> onChanged(false)) atomically clears sign-in
        // confirmation and marks signed out without waiting for a failing probe, blocking
        // options-only updates in both watcher and readiness.
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.auth!.logout!(Effect.void);
            expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unknown");
            expect(yield* readPersistedAuthConfirmed()).toBe(false);
            yield* awaitLiveWatchUpdate(
              coordinator.publishLiveConfiguration(identity.instanceId, {
                models: [],
                currentModelId: null,
                configOptions: [
                  {
                    id: "mode",
                    label: "Mode",
                    type: "select",
                    currentValue: "plan",
                    options: [
                      { id: "plan", label: "Plan" },
                      { id: "code", label: "Code" },
                    ],
                  },
                ],
                modelOptionIds: [],
                modelsFromModelSelect: false,
              }),
            );
            expect(
              (yield* instance.snapshot.getSnapshot).models.flatMap(
                (m) => m.capabilities?.optionDescriptors ?? [],
              ),
            ).toEqual([]);
            yield* instance.snapshot.refresh;
            const snapAfterAuthLogoutRefresh = yield* instance.snapshot.getSnapshot;
            expect(snapAfterAuthLogoutRefresh.auth.status).toBe("unknown");
            expect(
              snapAfterAuthLogoutRefresh.models.flatMap(
                (m) => m.capabilities?.optionDescriptors ?? [],
              ),
            ).toEqual([]);
          }),
        );

        // A ready probe reopens options replay before building the snapshot so compatible
        // options published while signed out are immediately replayed on the probe snapshot.
        yield* writeModels({
          models: ["new-model", "old-model"],
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "new-model",
              options: [
                { value: "new-model", name: "New Model" },
                { value: "old-model", name: "Old Model" },
              ],
            },
            {
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "code",
              options: [
                { value: "plan", name: "Plan" },
                { value: "code", name: "Code" },
              ],
            },
          ],
        });
        const readyReplayedSignedOutOption = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(readyReplayedSignedOutOption))
            .models.find((m) => m.slug === "new-model")
            ?.capabilities?.optionDescriptors?.find((d) => d.id === "mode")?.currentValue,
        ).toBe("plan");

        // Explicit management logout clears persisted sign-in confirmation and marks signed out;
        // a ready probe that loses a live-catalog race (during commit or before the first revision
        // check) keeps the newer catalog while reopening options replay, unless superseded.
        const postReconfirmEnriched = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.auth!.start("owner", Effect.void, "agent-login");
        expect(Option.getOrThrow(yield* Fiber.join(postReconfirmEnriched)).auth.status).toBe(
          "authenticated",
        );
        expect(yield* readPersistedAuthConfirmed()).toBe(true);
        yield* instance.acpSessionManagement!.logout(directory);
        expect(yield* readPersistedAuthConfirmed()).toBe(false);
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "new-model",
            configOptions: [
              {
                id: "blocked-after-mgmt-logout",
                label: "Blocked After Mgmt Logout",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["blocked-after-mgmt-logout"],
            modelsFromModelSelect: false,
          }),
        );
        expect(
          (yield* instance.snapshot.getSnapshot).models
            .find((m) => m.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).not.toContain("blocked-after-mgmt-logout");
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.snapshot.refresh;
            expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unknown");
          }),
        );
        injectCatalogBeforeReadyClear = true;
        const racedReadyApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models.map((m) => m.slug).join() === "raced-ready-a,raced-ready-b",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(readyRaceRejected);
        yield* Fiber.join(racedReadyApplied);
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "raced-ready-b",
            configOptions: [
              {
                id: "after-raced-ready",
                label: "After Raced Ready",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["after-raced-ready"],
            modelsFromModelSelect: false,
          }),
        );
        const snapAfterRacedReady = yield* instance.snapshot.getSnapshot;
        expect(snapAfterRacedReady.nativeSessions).toBeUndefined();
        expect(
          snapAfterRacedReady.models
            .find((m) => m.slug === "raced-ready-b")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toContain("after-raced-ready");

        // Same ready-probe catalog race when the live catalog arrives mid-probe (before the
        // commit's first revision check, advancing both cache generation and catalog revision):
        // reopening must also replay pending options still held by the coordinator before later
        // updates advance the applied revision past them.
        yield* instance.acpSessionManagement!.logout(directory);
        yield* runGatedProbe(
          Effect.gen(function* () {
            yield* awaitLiveWatchUpdate(
              coordinator.publishLiveConfiguration(identity.instanceId, {
                models: [
                  { id: "mid-raced-a", name: "Mid Raced A", description: null },
                  { id: "mid-raced-b", name: "Mid Raced B", description: null },
                ],
                currentModelId: "mid-raced-a",
                configOptions: [],
                modelsFromModelSelect: true,
              }),
            );
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "mid-raced-a",
              "mid-raced-b",
            ]);
            yield* awaitLiveWatchUpdate(
              coordinator.publishLiveConfiguration(identity.instanceId, {
                models: [],
                currentModelId: "mid-raced-b",
                configOptions: [
                  {
                    id: "dropped-while-signed-out",
                    label: "Dropped While Signed Out",
                    type: "boolean",
                    currentValue: true,
                  },
                ],
                modelOptionIds: ["dropped-while-signed-out"],
                modelsFromModelSelect: false,
              }),
            );
            expect(
              (yield* instance.snapshot.getSnapshot).models.find((m) => m.slug === "mid-raced-b")
                ?.capabilities?.optionDescriptors ?? [],
            ).toEqual([]);
          }),
        );
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "mid-raced-a",
            configOptions: [
              {
                id: "after-mid-raced-ready",
                label: "After Mid Raced Ready",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["after-mid-raced-ready"],
            modelsFromModelSelect: false,
          }),
        );
        const snapAfterMidRace = yield* instance.snapshot.getSnapshot;
        expect(snapAfterMidRace.models.map((m) => m.slug)).toEqual(["mid-raced-a", "mid-raced-b"]);
        expect(snapAfterMidRace.nativeSessions).toBeUndefined();
        expect(
          snapAfterMidRace.models
            .find((m) => m.slug === "mid-raced-b")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toContain("dropped-while-signed-out");
        expect(
          snapAfterMidRace.models
            .find((m) => m.slug === "mid-raced-a")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).toContain("after-mid-raced-ready");

        // Same ready-probe catalog race when only coordinator catalogRevision advanced (the live
        // watcher has not processed the catalog yet, so cache generation is unchanged): the commit
        // must still take the early return and replay the new catalog + pending options immediately.
        yield* instance.acpSessionManagement!.logout(directory);
        const releaseBlockedWatch = yield* Deferred.make<void>();
        const blockedWatchDrained = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          let unwatchedOptRevision = 0;
          yield* runGatedProbe(
            Effect.gen(function* () {
              blockLiveWatch = releaseBlockedWatch;
              yield* coordinator.publishLiveConfiguration(identity.instanceId, {
                models: [
                  { id: "unwatched-a", name: "Unwatched A", description: null },
                  { id: "unwatched-b", name: "Unwatched B", description: null },
                ],
                currentModelId: "unwatched-a",
                configOptions: [],
                modelsFromModelSelect: true,
              });
              yield* coordinator.publishLiveConfiguration(identity.instanceId, {
                models: [],
                currentModelId: "unwatched-b",
                configOptions: [
                  {
                    id: "unwatched-opt",
                    label: "Unwatched Opt",
                    type: "boolean",
                    currentValue: true,
                  },
                ],
                modelOptionIds: ["unwatched-opt"],
                modelsFromModelSelect: false,
              });
              unwatchedOptRevision = (yield* coordinator.getLiveConfigurationWithRevision(
                identity.instanceId,
              )).revision;
            }),
          );
          // publishAvailableCommands acquires liveSnapshotSemaphore, proving commitEnrichment
          // has finished while the live-configuration watcher is still blocked.
          const sawCommitFinished = yield* instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) =>
              (snapshot.slashCommands ?? []).some((command) => command.name === "sync-commit"),
            ),
            Stream.runHead,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* coordinator.publishAvailableCommands(identity.instanceId, {
            slashCommands: [{ name: "sync-commit", description: "Sync commit" }],
            skills: [],
          });
          const snapBeforeWatchDrains = Option.getOrThrow(yield* Fiber.join(sawCommitFinished));
          expect(snapBeforeWatchDrains.models.map((m) => m.slug)).toEqual([
            "unwatched-a",
            "unwatched-b",
          ]);
          expect(snapBeforeWatchDrains.nativeSessions).toBeUndefined();
          expect(
            snapBeforeWatchDrains.models
              .find((m) => m.slug === "unwatched-b")
              ?.capabilities?.optionDescriptors?.map((d) => d.id),
          ).toContain("unwatched-opt");
          pendingLiveWatch = { minRevision: unwatchedOptRevision, done: blockedWatchDrained };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              blockLiveWatch = null;
            }).pipe(Effect.andThen(Deferred.succeed(releaseBlockedWatch, undefined))),
          ),
        );
        yield* Deferred.await(blockedWatchDrained);

        // An in-flight ready probe superseded by explicit sign-out must NOT reopen options replay.
        yield* runGatedProbe(
          Effect.gen(function* () {
            yield* instance.acpSessionManagement!.logout(directory);
            yield* awaitLiveWatchUpdate(
              coordinator.publishLiveConfiguration(identity.instanceId, {
                models: [
                  { id: "post-logout-a", name: "Post Logout A", description: null },
                  { id: "post-logout-b", name: "Post Logout B", description: null },
                ],
                currentModelId: "post-logout-a",
                configOptions: [],
                modelsFromModelSelect: true,
              }),
            );
          }),
        );
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "post-logout-b",
            configOptions: [
              {
                id: "blocked-after-raced-logout",
                label: "Blocked After Raced Logout",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["blocked-after-raced-logout"],
            modelsFromModelSelect: false,
          }),
        );
        const snapAfterRacedLogout = yield* instance.snapshot.getSnapshot;
        expect(snapAfterRacedLogout.models.map((m) => m.slug)).toEqual([
          "post-logout-a",
          "post-logout-b",
        ]);
        expect(
          snapAfterRacedLogout.models
            .find((m) => m.slug === "post-logout-b")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).not.toContain("blocked-after-raced-logout");

        // An in-flight ready probe while signed out superseded by cache/auth reset must also
        // keep options replay closed.
        yield* runGatedProbe(instance.invalidateCaches!);
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "post-logout-b",
            configOptions: [
              {
                id: "blocked-after-raced-invalidate",
                label: "Blocked After Raced Invalidate",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["blocked-after-raced-invalidate"],
            modelsFromModelSelect: false,
          }),
        );
        expect(
          (yield* instance.snapshot.getSnapshot).models
            .find((m) => m.slug === "post-logout-b")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).not.toContain("blocked-after-raced-invalidate");

        // A transient non-auth probe failure while signed out must NOT reopen options replay.
        yield* writeModels({ fail: "Temporary discovery outage" });
        yield* runGatedProbe(Effect.void);
        yield* awaitLiveWatchUpdate(
          coordinator.publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "post-logout-b",
            configOptions: [
              {
                id: "blocked-after-transient-warning",
                label: "Blocked After Transient Warning",
                type: "boolean",
                currentValue: true,
              },
            ],
            modelOptionIds: ["blocked-after-transient-warning"],
            modelsFromModelSelect: false,
          }),
        );
        const snapAfterTransientWarning = yield* instance.snapshot.getSnapshot;
        expect(snapAfterTransientWarning.status).toBe("warning");
        expect(
          snapAfterTransientWarning.models
            .find((m) => m.slug === "post-logout-b")
            ?.capabilities?.optionDescriptors?.map((d) => d.id),
        ).not.toContain("blocked-after-transient-warning");
      }),
  );

  it.effect(
    "keeps a live session catalog published while a post-TTL probe is in flight and preserves explicit singleton provenance",
    () =>
      Effect.gen(function* () {
        const secondProbeEntered = yield* Deferred.make<void>();
        const releaseSecondProbe = yield* Deferred.make<void>();
        const secondProbeEnteredCommit = yield* Deferred.make<void>();
        let gateNextResolve = false;
        let secondProbeReleased = false;

        const { coordinator, instance, waitForEnriched, writeModels } = yield* setupPeriodicDriver({
          prefix: "acp-driver-inflight-",
          initialModels: ["old-model", "other-model"],
          wrapCoordinator: (base) => ({
            ...base,
            getLiveConfigurationWithRevision: (instanceId) =>
              base
                .getLiveConfigurationWithRevision(instanceId)
                .pipe(
                  Effect.tap(() =>
                    secondProbeReleased
                      ? Deferred.succeed(secondProbeEnteredCommit, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
          }),
          onResolve: () =>
            Effect.gen(function* () {
              if (gateNextResolve) {
                gateNextResolve = false;
                yield* Deferred.succeed(secondProbeEntered, undefined);
                yield* Deferred.await(releaseSecondProbe);
                secondProbeReleased = true;
              }
            }),
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        yield* writeModels(["old-model", "other-model", "stale-probe-model"]);
        yield* TestClock.adjust("16 minutes");
        gateNextResolve = true;
        yield* instance.snapshot.refresh;
        yield* Deferred.await(secondProbeEntered);

        const liveApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.models.map((m) => m.slug).join() === "entitled-model",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [{ id: "entitled-model", name: "Entitled", description: null }],
          currentModelId: "entitled-model",
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(liveApplied);

        yield* Deferred.succeed(releaseSecondProbe, undefined);
        // Wait for the competing probe to enter commit (holding liveSnapshotSemaphore), then
        // wait for a semaphore-serialized command publication so commit has fully released it.
        yield* Deferred.await(secondProbeEnteredCommit);
        const commitReleased = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "commit-settled"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "commit-settled" }],
          skills: [],
        });
        yield* Fiber.join(commitReleased);

        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "entitled-model",
        ]);
        expect(
          Option.map(
            yield* coordinator.getLiveConfiguration(identity.instanceId),
            (config) => config.currentModelId,
          ),
        ).toEqual(Option.some("entitled-model"));
        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "entitled-model",
        ]);

        // A subsequent provisional single-model live update must not replace the explicit singleton
        // catalog, overwrite its model-specific options, or downgrade its provenance.
        const provisionalProcessed = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "entitled-model")
                ?.capabilities?.optionDescriptors?.some((option) => option.id === "mode") === true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [{ id: "live-placeholder", name: "Live Placeholder", description: null }],
          currentModelId: "live-placeholder",
          configOptions: [
            {
              id: "mode",
              label: "Mode",
              type: "select",
              currentValue: "code",
              options: [{ id: "code", label: "Code" }],
            },
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "on",
              options: [
                { id: "off", label: "Off" },
                { id: "on", label: "On" },
              ],
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        const retainedAfterProvisional = Option.getOrThrow(yield* Fiber.join(provisionalProcessed));
        expect(retainedAfterProvisional.models.map((model) => model.slug)).toEqual([
          "entitled-model",
        ]);
        expect(
          retainedAfterProvisional.models
            .find((model) => model.slug === "entitled-model")
            ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort"),
        ).toMatchObject({
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        });

        yield* writeModels({ provisional: "placeholder" });
        yield* TestClock.adjust("16 minutes");
        const afterProvisionalProbe = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(afterProvisionalProbe)).models.map(
            (model) => model.slug,
          ),
        ).toEqual(["entitled-model"]);
      }),
  );

  it.effect(
    "commits a fresh post-TTL catalog when only an options-only live update arrives in flight while suppressing delayed raw callbacks",
    () =>
      Effect.gen(function* () {
        const secondProbeEntered = yield* Deferred.make<void>();
        const releaseSecondProbe = yield* Deferred.make<void>();
        const delayedOptionsEntered = yield* Deferred.make<void>();
        const releaseDelayedOptions = yield* Deferred.make<void>();
        const delayedOptionsDone = yield* Deferred.make<void>();
        let gateNextResolve = false;
        let holdNextOptionsCallback = false;

        const {
          coordinator,
          instance,
          waitForEnriched,
          writeModels,
          withBlockedForegroundStartup,
        } = yield* setupPeriodicDriver({
          prefix: "acp-driver-inflight-options-",
          initialModels: ["old-model", "other-model"],
          wrapCoordinator: (base) => ({
            ...base,
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) =>
                  holdNextOptionsCallback && configuration.models.length === 0
                    ? Effect.sync(() => {
                        holdNextOptionsCallback = false;
                      }).pipe(
                        Effect.andThen(Deferred.succeed(delayedOptionsEntered, undefined)),
                        Effect.andThen(Deferred.await(releaseDelayedOptions)),
                        Effect.andThen(onUpdate(configuration, revision)),
                        Effect.andThen(Deferred.succeed(delayedOptionsDone, undefined)),
                        Effect.asVoid,
                      )
                    : onUpdate(configuration, revision),
                options,
              ),
          }),
          onResolve: () =>
            Effect.gen(function* () {
              if (gateNextResolve) {
                gateNextResolve = false;
                yield* Deferred.succeed(secondProbeEntered, undefined);
                yield* Deferred.await(releaseSecondProbe);
              }
            }),
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        // Fresh probe advertises mode=[code, plan], restricts effort on old-model to [low] only,
        // and disables reasoning on other-model while adding new-model.
        yield* writeModels({
          models: [
            "old-model",
            {
              modelId: "other-model",
              name: "other-model",
              _meta: { supportsReasoningEffort: false },
            },
            "new-model",
          ],
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "code",
              options: [
                { value: "code", name: "Code" },
                { value: "plan", name: "Plan" },
              ],
            },
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "low",
              options: [{ value: "low", name: "Low" }],
            },
          ],
        });
        yield* TestClock.adjust("16 minutes");
        gateNextResolve = true;
        yield* instance.snapshot.refresh;
        yield* Deferred.await(secondProbeEntered);

        // Hold the raw watcher callback for this in-flight options-only revision until after the
        // probe commits, verifying clearedThroughRevision advances past it and the snapshot stays clean.
        holdNextOptionsCallback = true;
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "old-model",
          configOptions: [
            {
              id: "mode",
              label: "Mode",
              type: "select",
              currentValue: "plan",
              options: [
                { id: "code", label: "Code" },
                { id: "plan", label: "Plan" },
              ],
            },
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* Deferred.await(delayedOptionsEntered);
        const inFlightRevision = (yield* coordinator.getLiveConfigurationWithRevision(
          identity.instanceId,
        )).revision;

        const committed = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseSecondProbe, undefined);
        const updated = Option.getOrThrow(yield* Fiber.join(committed));
        expect(
          (yield* coordinator.getLiveConfigurationWithRevision(identity.instanceId))
            .clearedThroughRevision,
        ).toBe(inFlightRevision);
        expect(updated.models.map((model) => model.slug)).toEqual([
          "old-model",
          "other-model",
          "new-model",
        ]);
        // Valid live option (mode=plan) survives while the removed choice (effort=high) is replaced by probe's low.
        expect(
          updated.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["mode", "plan"],
          ["effort", "low"],
        ]);
        expect(
          updated.models
            .find((model) => model.slug === "other-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([["mode", "plan"]]);

        // Releasing the delayed raw watcher callback leaves the reconciled snapshot and cache intact.
        yield* Deferred.succeed(releaseDelayedOptions, undefined);
        yield* Deferred.await(delayedOptionsDone);
        expect(
          (yield* instance.snapshot.getSnapshot).models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["mode", "plan"],
          ["effort", "low"],
        ]);

        // Verify the fresh catalog was saved to acceptedCatalog (survives skipped readiness) and cache.
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.snapshot.refresh;
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "old-model",
              "other-model",
              "new-model",
            ]);
          }),
        );

        yield* writeModels(["unexpected-reprobe", "other-model"]);
        const cached = yield* waitForEnriched().pipe(Effect.forkScoped({ startImmediately: true }));
        yield* instance.snapshot.refresh;
        const cachedSnapshot = Option.getOrThrow(yield* Fiber.join(cached));
        expect(cachedSnapshot.models.map((model) => model.slug)).toEqual([
          "old-model",
          "other-model",
          "new-model",
        ]);
        expect(
          cachedSnapshot.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([
          ["mode", "plan"],
          ["effort", "low"],
        ]);
      }),
  );

  it.effect(
    "skips a delayed live-watcher callback after a fresh probe supersedes its revision",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "acp-driver-stale-watcher-",
        });
        const agentPath = path.join(directory, "agent.mjs");
        const modelsPath = path.join(directory, "models.json");
        yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "other-model"]));
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const allowProbe = yield* Deferred.make<void>();
        const staleCallbackEntered = yield* Deferred.make<void>();
        const releaseStaleCallback = yield* Deferred.make<void>();
        const staleCallbackDone = yield* Deferred.make<void>();
        const newerCallbackEntered = yield* Deferred.make<void>();
        const releaseNewerCallback = yield* Deferred.make<void>();
        const newerCallbackDone = yield* Deferred.make<void>();
        const secondWatcherSubscribed = yield* Deferred.make<void>();
        let checkProviderInspected = false;
        let skipNextLiveRead = false;
        let armed = false;
        let trackNextWatcher = false;

        const gatedCoordinator: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"] =
          {
            ...coordinator,
            getLiveConfigurationWithRevision: (instanceId) =>
              Effect.gen(function* () {
                if (armed) {
                  if (skipNextLiveRead) {
                    skipNextLiveRead = false;
                  } else {
                    armed = false;
                    yield* Deferred.await(allowProbe);
                  }
                }
                return yield* coordinator.getLiveConfigurationWithRevision(instanceId);
              }),
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              Effect.gen(function* () {
                if (trackNextWatcher) {
                  trackNextWatcher = false;
                  yield* Deferred.succeed(secondWatcherSubscribed, undefined);
                }
                return yield* coordinator.watchLiveConfiguration(
                  instanceId,
                  (configuration, revision) =>
                    configuration.currentModelId === "stale-live-model"
                      ? Deferred.succeed(staleCallbackEntered, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseStaleCallback)),
                          Effect.andThen(onUpdate(configuration, revision)),
                          Effect.andThen(Deferred.succeed(staleCallbackDone, undefined)),
                          Effect.asVoid,
                        )
                      : configuration.currentModelId === "newer-live-model"
                        ? Deferred.succeed(newerCallbackEntered, undefined).pipe(
                            Effect.andThen(Deferred.await(releaseNewerCallback)),
                            Effect.andThen(onUpdate(configuration, revision)),
                            Effect.andThen(Deferred.succeed(newerCallbackDone, undefined)),
                            Effect.asVoid,
                          )
                        : onUpdate(configuration, revision),
                  options,
                );
              }),
          };

        const readyInspection = {
          status: "ready" as const,
          agentId: "test-agent",
          version: "1.0.0",
          distribution: "npx" as const,
        };
        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: identity.displayName,
          enabled: true,
          environment: [],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            gatedCoordinator,
          ),
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
            ...catalogWithInspection(readyInspection),
            inspect: () =>
              Effect.sync(() => {
                if (armed && !checkProviderInspected) {
                  checkProviderInspected = true;
                  skipNextLiveRead = true;
                }
                return readyInspection;
              }),
            resolve: () =>
              Effect.succeed({
                distribution: "npx" as const,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              }),
          }),
        );

        const waitForEnriched = () =>
          instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
            Stream.runHead,
          );

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["old-model", "other-model", "new-model"]),
        );
        yield* TestClock.adjust("16 minutes");
        armed = true;
        trackNextWatcher = true;

        const probed = yield* waitForEnriched().pipe(Effect.forkScoped({ startImmediately: true }));
        yield* instance.snapshot.refresh;
        yield* Deferred.await(secondWatcherSubscribed);

        // Publish a live configuration whose watcher callback pauses before acquiring the snapshot semaphore.
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "old-model", name: "old-model", description: null },
            { id: "stale-live-model", name: "stale-live-model", description: null },
          ],
          currentModelId: "stale-live-model",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* Deferred.await(staleCallbackEntered);

        // Let the fresh probe observe and clear that revision, publishing the newer catalog.
        yield* Deferred.succeed(allowProbe, undefined);
        expect(
          Option.getOrThrow(yield* Fiber.join(probed)).models.map((model) => model.slug),
        ).toEqual(["old-model", "other-model", "new-model"]);

        // Publish a newer live revision while the stale callback is still paused so currentLive is
        // Option.some(newer) when the stale callback resumes, specifically exercising the
        // clearedThroughRevision watermark.
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "old-model", name: "old-model", description: null },
            { id: "newer-live-model", name: "newer-live-model", description: null },
          ],
          currentModelId: "newer-live-model",
          configOptions: [],
          modelsFromModelSelect: true,
        });

        // Releasing the delayed watcher callback must not overwrite the snapshot, cache, or accepted catalog.
        yield* Deferred.succeed(releaseStaleCallback, undefined);
        yield* Deferred.await(staleCallbackDone);
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "old-model",
          "other-model",
          "new-model",
        ]);

        // The newer live revision queued behind it must still be applied.
        yield* Deferred.await(newerCallbackEntered);
        yield* Deferred.succeed(releaseNewerCallback, undefined);
        yield* Deferred.await(newerCallbackDone);
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "old-model",
          "newer-live-model",
        ]);

        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["unexpected-reprobe", "other-model"]),
        );
        const cached = yield* waitForEnriched().pipe(Effect.forkScoped({ startImmediately: true }));
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(cached)).models.map((model) => model.slug),
        ).toEqual(["old-model", "newer-live-model"]);
      }),
  );

  it.effect(
    "syncs acceptedCatalog during readiness handoff when a refresh interrupts an unapplied live catalog",
    () =>
      Effect.gen(function* () {
        const handoffCallbackBlocked = yield* Deferred.make<void>();
        let blockHandoffWatcher = false;
        let retiringRaceArmed = false;
        let retiringRacePending = false;
        let retiringWatcherReady = yield* Deferred.make<void>();
        let trackRetiringWatcherReady = false;
        let retiringReadyCount = 0;
        let retiringOnUpdate:
          | ((configuration: AcpRegistryLiveConfiguration, revision: number) => Effect.Effect<void>)
          | null = null;
        let retiringRaceUpdates: Array<{
          readonly configuration: AcpRegistryLiveConfiguration;
          readonly revision: number;
        }> = [];
        const racedCatalog: AcpRegistryLiveConfiguration = {
          models: [
            { id: "raced-a", name: "Raced A", description: null },
            { id: "raced-b", name: "Raced B", description: null },
          ],
          currentModelId: "raced-a",
          configOptions: [],
          modelsFromModelSelect: true,
        };
        const racedOptions: AcpRegistryLiveConfiguration = {
          models: [],
          currentModelId: "raced-b",
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        };
        const markRetiringReady = () =>
          Effect.suspend(() => {
            if (!trackRetiringWatcherReady) return Effect.void;
            retiringReadyCount += 1;
            if (retiringReadyCount < 2) return Effect.void;
            trackRetiringWatcherReady = false;
            return Deferred.succeed(retiringWatcherReady, undefined).pipe(Effect.asVoid);
          });
        const {
          coordinator,
          instance,
          waitForEnriched,
          writeModels,
          withBlockedForegroundStartup,
        } = yield* setupPeriodicDriver({
          prefix: "acp-driver-handoff-",
          initialModels: ["old-model", "other-model"],
          wrapCoordinator: (base) => ({
            ...base,
            getUrlAuthAction: (instanceId) =>
              base.getUrlAuthAction(instanceId).pipe(
                Effect.tap(() =>
                  retiringRaceArmed
                    ? Effect.gen(function* () {
                        retiringRaceArmed = false;
                        retiringRacePending = true;
                        yield* base.publishLiveConfiguration(instanceId, racedCatalog);
                        const r2 = (yield* base.getLiveConfigurationWithRevision(instanceId))
                          .revision;
                        yield* base.publishLiveConfiguration(instanceId, racedOptions);
                        const r3 = (yield* base.getLiveConfigurationWithRevision(instanceId))
                          .revision;
                        retiringRaceUpdates = [
                          { configuration: racedCatalog, revision: r2 },
                          { configuration: racedOptions, revision: r3 },
                        ];
                      })
                    : Effect.void,
                ),
              ),
            watchUrlAuthAction: (instanceId, onUpdate) =>
              markRetiringReady().pipe(
                Effect.andThen(base.watchUrlAuthAction(instanceId, onUpdate)),
                Effect.ensuring(
                  Effect.suspend(() => {
                    if (!retiringRacePending || retiringOnUpdate === null) return Effect.void;
                    retiringRacePending = false;
                    const runUpdate = retiringOnUpdate;
                    const updates = retiringRaceUpdates;
                    retiringRaceUpdates = [];
                    return Effect.forEach(updates, ({ configuration, revision }) =>
                      runUpdate(configuration, revision),
                    ).pipe(Effect.asVoid);
                  }),
                ),
              ),
            watchLiveConfiguration: (instanceId, onUpdate, options) => {
              retiringOnUpdate = onUpdate;
              return markRetiringReady().pipe(
                Effect.andThen(
                  base.watchLiveConfiguration(
                    instanceId,
                    (configuration, revision) => {
                      if (retiringRacePending && onUpdate === retiringOnUpdate) return Effect.void;
                      return blockHandoffWatcher && configuration.currentModelId === "handoff-a"
                        ? Effect.sync(() => {
                            blockHandoffWatcher = false;
                          }).pipe(
                            Effect.andThen(Deferred.succeed(handoffCallbackBlocked, undefined)),
                            Effect.andThen(Effect.never),
                          )
                        : onUpdate(configuration, revision);
                    },
                    options,
                  ),
                ),
              );
            },
          }),
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        // Publish a live catalog whose watcher callback blocks until refresh interrupts it.
        blockHandoffWatcher = true;
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "handoff-a", name: "Handoff A", description: null },
            { id: "handoff-b", name: "Handoff B", description: null },
          ],
          currentModelId: "handoff-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* Deferred.await(handoffCallbackBlocked);

        // Refresh interrupts the blocked watcher; readiness must still have synced acceptedCatalog
        // before recording lastObservedLiveRevision, so clearing the coordinator and running a
        // subsequent provisional probe still keeps the accepted catalog.
        yield* instance.snapshot.refresh;
        yield* coordinator.clearLiveConfiguration(identity.instanceId);
        yield* writeModels({ provisional: "placeholder" });
        yield* TestClock.adjust("16 minutes");
        const afterProvisional = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(afterProvisional)).models.map((m) => m.slug),
        ).toEqual(["handoff-a", "handoff-b"]);

        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            retiringWatcherReady = yield* Deferred.make<void>();
            trackRetiringWatcherReady = true;
            yield* instance.snapshot.refresh;
            yield* Deferred.await(retiringWatcherReady);
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "handoff-a",
              "handoff-b",
            ]);

            // If the retiring live watcher applies a newer catalog (R2) and options update (R3)
            // after readiness reads R1 and applySnapshotBase commits R1, basing live watcher steps
            // on acceptedCatalog.models keeps R3 from corrupting acceptedCatalog back to R1 and
            // lets the replacement watcher's R3 replay publish the already-accepted catalog.
            const sawRacedRestored = yield* instance.snapshot.streamChanges.pipe(
              Stream.filter(
                (snapshot) =>
                  snapshot.models.map((m) => m.slug).join() === "raced-a,raced-b" &&
                  snapshot.models.find((m) => m.slug === "raced-b")?.isDefault === true &&
                  snapshot.models
                    .find((m) => m.slug === "raced-b")
                    ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")
                    ?.currentValue === "high",
              ),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            );
            retiringRaceArmed = true;
            yield* instance.snapshot.refresh;
            const restoredRaced = Option.getOrThrow(yield* Fiber.join(sawRacedRestored));
            expect(restoredRaced.models.map((m) => m.slug)).toEqual(["raced-a", "raced-b"]);
            expect(restoredRaced.models.find((m) => m.slug === "raced-b")?.isDefault).toBe(true);
            expect(
              restoredRaced.models
                .find((m) => m.slug === "raced-b")
                ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
            ).toEqual([["effort", "high"]]);
          }),
        );
      }),
  );

  it.effect(
    "does not revert learned options to an already-applied catalog and replays all blocked per-model options on refresh",
    () =>
      Effect.gen(function* () {
        const blockBWatcher = yield* Deferred.make<void>();
        let shouldBlockB = false;
        const { coordinator, instance, waitForEnriched } = yield* setupPeriodicDriver({
          prefix: "acp-driver-replay-",
          initialModels: ["model-a", "model-b"],
          wrapCoordinator: (base) => ({
            ...base,
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) =>
                  shouldBlockB && configuration.currentModelId === "model-b"
                    ? Effect.sync(() => {
                        shouldBlockB = false;
                      }).pipe(
                        Effect.andThen(Deferred.succeed(blockBWatcher, undefined)),
                        Effect.andThen(Effect.never),
                      )
                    : onUpdate(configuration, revision),
                options,
              ),
          }),
        });
        const effortSelect = (currentValue: "low" | "high") => ({
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue,
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        });
        const variantSelect = (currentValue: "v1" | "v2") => ({
          id: "variant",
          label: "Variant",
          type: "select" as const,
          currentValue,
          options: [
            { id: "v1", label: "V1" },
            { id: "v2", label: "V2" },
          ],
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        // Publish catalog [model-a (effort=low), model-b], then update model-a to effort=high,
        // then switch to model-b. A readiness refresh must not relearn effort=low from the catalog.
        const waitForEffort = (slug: string, expected: string) =>
          instance.snapshot.streamChanges.pipe(
            Stream.filter(
              (snapshot) =>
                snapshot.models
                  .find((m) => m.slug === slug)
                  ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")
                  ?.currentValue === expected,
            ),
            Stream.runHead,
            Effect.forkScoped({ startImmediately: true }),
          );

        const sawLow = yield* waitForEffort("model-a", "low");
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null },
            { id: "model-b", name: "Model B", description: null },
          ],
          currentModelId: "model-a",
          configOptions: [effortSelect("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(sawLow);

        const sawHigh = yield* waitForEffort("model-a", "high");
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [effortSelect("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(sawHigh);

        const sawBDefault = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.models.find((m) => m.slug === "model-b")?.isDefault === true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(sawBDefault);

        const refreshed = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const afterRefresh = Option.getOrThrow(yield* Fiber.join(refreshed));
        expect(
          afterRefresh.models
            .find((m) => m.slug === "model-a")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "high"]]);
        expect(afterRefresh.models.find((m) => m.slug === "model-b")?.isDefault).toBe(true);

        // Block the watcher on model-b, then publish both model-b (variant=v1) and model-a (effort=low).
        // Readiness handoff must replay both pending per-model updates, not only the last one.
        shouldBlockB = true;
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [variantSelect("v1")],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
        });
        yield* Deferred.await(blockBWatcher);
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [effortSelect("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });

        const handoff = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const afterHandoff = Option.getOrThrow(yield* Fiber.join(handoff));
        expect(
          afterHandoff.models
            .find((m) => m.slug === "model-b")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["variant", "v1"]]);
        expect(
          afterHandoff.models
            .find((m) => m.slug === "model-a")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "low"]]);
      }),
  );

  it.effect(
    "removes options a live model stops reporting after a superseding probe and preserves concurrent live catalogs",
    () =>
      Effect.gen(function* () {
        let injectLiveCatalogAfterClear = false;
        const { coordinator, instance, waitForEnriched, writeModels } = yield* setupPeriodicDriver({
          prefix: "acp-driver-post-probe-",
          initialModels: ["model-a", "model-b"],
          wrapCoordinator: (base) => ({
            ...base,
            clearLiveConfigurationIfRevision: (instanceId, options) =>
              base.clearLiveConfigurationIfRevision(instanceId, options).pipe(
                Effect.tap((cleared) =>
                  Option.isSome(cleared) && injectLiveCatalogAfterClear
                    ? Effect.sync(() => {
                        injectLiveCatalogAfterClear = false;
                      }).pipe(
                        Effect.andThen(
                          base.publishLiveConfiguration(instanceId, {
                            models: [
                              { id: "live-c", name: "Live C", description: null },
                              { id: "live-d", name: "Live D", description: null },
                            ],
                            currentModelId: "live-c",
                            configOptions: [],
                            modelsFromModelSelect: true,
                          }),
                        ),
                        Effect.andThen(
                          base.publishLiveConfiguration(instanceId, {
                            models: [],
                            currentModelId: "live-c",
                            configOptions: [
                              {
                                id: "effort",
                                label: "Effort",
                                type: "select",
                                role: "reasoning",
                                currentValue: "high",
                                options: [
                                  { id: "low", label: "Low" },
                                  { id: "high", label: "High" },
                                ],
                              },
                            ],
                            modelOptionIds: ["effort"],
                            modelsFromModelSelect: false,
                          }),
                        ),
                      )
                    : Effect.void,
                ),
              ),
          }),
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        // Publish a live catalog so the next probe supersedes a live session and records probeOptions.
        const sawPreProbe = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((m) => m.slug === "pre-probe")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null },
            { id: "pre-probe", name: "Pre Probe", description: null },
          ],
          currentModelId: "model-a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(sawPreProbe);

        yield* writeModels(["model-a", "model-b"]);
        yield* TestClock.adjust("16 minutes");
        const superseded = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(superseded);

        // Model B learns variant=v1, then reports no options: variant must be dropped while keeping B default.
        const sawVariant = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "model-b")
                ?.capabilities?.optionDescriptors?.some((d) => d.id === "variant") === true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [
            {
              id: "variant",
              label: "Variant",
              type: "select",
              currentValue: "v1",
              options: [{ id: "v1", label: "V1" }],
            },
          ],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(sawVariant);

        const sawDropped = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models.find((m) => m.slug === "model-b")?.isDefault === true &&
              (snapshot.models.find((m) => m.slug === "model-b")?.capabilities?.optionDescriptors
                ?.length ?? 0) === 0,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(sawDropped);

        const afterDropRefresh = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const droppedSnapshot = Option.getOrThrow(yield* Fiber.join(afterDropRefresh));
        expect(droppedSnapshot.models.find((m) => m.slug === "model-b")?.isDefault).toBe(true);
        expect(
          droppedSnapshot.models.find((m) => m.slug === "model-b")?.capabilities?.optionDescriptors,
        ).toEqual([]);

        // When a fresh live catalog + options-only update arrive right after clearLiveConfigurationIfRevision,
        // the probe commit's replay must preserve the new catalog and its options (using the replayed
        // catalog's reasoning rules rather than the probe's disabled-model set or baseline).
        injectLiveCatalogAfterClear = true;
        yield* writeModels({
          models: [
            { modelId: "live-c", name: "Live C", _meta: { supportsReasoningEffort: false } },
            { modelId: "probe-2", name: "Probe 2" },
          ],
        });
        yield* TestClock.adjust("16 minutes");
        const concurrentCommit = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const published = Option.getOrThrow(yield* Fiber.join(concurrentCommit));
        expect(published.models.map((m) => m.slug)).toEqual(["live-c", "live-d"]);
        expect(
          published.models
            .find((m) => m.slug === "live-c")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "high"]]);

        // Persisting replayed steps during the cleared probe commit keeps acceptedCatalog and
        // enrichmentCache on ["live-c", "live-d"] so a subsequent cache-hit refresh does not
        // regress back to the superseded probe ["live-c", "probe-2"].
        const cachedAfterConcurrent = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const cachedSnap = Option.getOrThrow(yield* Fiber.join(cachedAfterConcurrent));
        expect(cachedSnap.models.map((m) => m.slug)).toEqual(["live-c", "live-d"]);
        expect(
          cachedSnap.models
            .find((m) => m.slug === "live-c")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "high"]]);
      }),
  );

  it.effect("preserves post-probe overflow selection and per-model learned values", () =>
    Effect.gen(function* () {
      const modelIds = Array.from({ length: 257 }, (_, index) => `m${index}`);
      const choices = modelIds.map((value, index) => ({ value, name: `Model ${index}` }));
      const modelSelect = (currentValue: string) => [
        {
          id: "model",
          name: "Model",
          category: "model" as const,
          type: "select" as const,
          currentValue,
          options: choices,
        },
      ];
      const effortSelect = (currentValue: "low" | "high" | "removed") => ({
        id: "effort",
        name: "Effort",
        category: "thought_level" as const,
        type: "select" as const,
        currentValue,
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      });
      const variantSelect = {
        id: "variant",
        name: "Variant",
        category: "model_config" as const,
        type: "select" as const,
        currentValue: "v1",
        options: [{ value: "v1", name: "V1" }],
      };

      let blockOverflowWatcher = false;
      const releaseOverflowWatcher = yield* Deferred.make<void>();
      let afterOverflowCacheReadHook: Effect.Effect<void> | null = null;
      const { coordinator, instance, waitForEnriched, writeModels } = yield* setupPeriodicDriver({
        prefix: "acp-driver-overflow-post-probe-",
        initialModels: {
          models: modelIds,
          configOptions: [...modelSelect("m0"), effortSelect("low")],
        },
        wrapCoordinator: (base) => ({
          ...base,
          runBackgroundProbe: (agentId, effect) =>
            base.runBackgroundProbe(
              agentId,
              effect.pipe(
                Effect.tap(() => {
                  const hook = afterOverflowCacheReadHook;
                  afterOverflowCacheReadHook = null;
                  return hook ?? Effect.void;
                }),
              ),
            ),
          watchLiveConfiguration: (instanceId, onUpdate, options) =>
            base.watchLiveConfiguration(
              instanceId,
              (configuration, revision) =>
                blockOverflowWatcher
                  ? Effect.sync(() => {
                      blockOverflowWatcher = false;
                    }).pipe(
                      Effect.andThen(Deferred.await(releaseOverflowWatcher)),
                      Effect.andThen(onUpdate(configuration, revision)),
                    )
                  : onUpdate(configuration, revision),
              options,
            ),
        }),
      });

      const initial = yield* waitForEnriched().pipe(Effect.forkScoped({ startImmediately: true }));
      yield* instance.snapshot.refresh;
      yield* Fiber.join(initial);

      // Publish initial live catalog for m0, then supersede with a fresh 257-model probe.
      const initialLive = prepareAcpRegistryLiveConfiguration([
        ...modelSelect("m0"),
        effortSelect("low"),
      ]).toLiveConfiguration({ includeCatalog: true });
      yield* coordinator.publishLiveConfiguration(identity.instanceId, initialLive);
      yield* writeModels({
        models: modelIds,
        configOptions: [...modelSelect("m0"), effortSelect("low")],
      });
      yield* TestClock.adjust("16 minutes");
      const superseded = yield* waitForEnriched().pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(superseded);

      // Selecting overflow model m256 after a superseding probe must swap slot 255 and mark m256 default.
      const sawM256 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.models.at(-1)?.slug === "m256" && snapshot.models.at(-1)?.isDefault === true,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration([
          ...modelSelect("m256"),
          variantSelect,
        ]).toLiveConfiguration({ includeCatalog: false }),
      );
      const afterM256 = Option.getOrThrow(yield* Fiber.join(sawM256));
      expect(afterM256.models).toHaveLength(256);
      expect(
        afterM256.models
          .at(-1)
          ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
      ).toEqual([["variant", "v1"]]);

      // Refresh must keep m256 selected in slot 255.
      const refreshM256 = yield* waitForEnriched().pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const refreshedM256 = Option.getOrThrow(yield* Fiber.join(refreshM256));
      expect(refreshedM256.models.at(-1)?.slug).toBe("m256");
      expect(refreshedM256.models.at(-1)?.isDefault).toBe(true);

      // Returning to m0 with effort=high restores m255 in slot 255 and learns m0 effort=high.
      const sawM0High = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.models[0]?.isDefault === true &&
            snapshot.models.at(-1)?.slug === "m255" &&
            snapshot.models[0]?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")
              ?.currentValue === "high",
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration([
          ...modelSelect("m0"),
          effortSelect("high"),
        ]).toLiveConfiguration({ includeCatalog: false }),
      );
      yield* Fiber.join(sawM0High);

      // Switching to m1 must keep m0's learned effort=high instead of reverting m0 to probe default low.
      const sawM1 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models[1]?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(modelSelect("m1")).toLiveConfiguration({
          includeCatalog: false,
        }),
      );
      const afterM1 = Option.getOrThrow(yield* Fiber.join(sawM1));
      expect(
        afterM1.models[0]?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
      ).toEqual([["effort", "high"]]);

      // Sending an invalid value for probe's default model m0 resets m0 back to probe default low.
      const sawM0Reset = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.models[0]?.isDefault === true &&
            snapshot.models[0]?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")
              ?.currentValue === "low",
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration([
          ...modelSelect("m0"),
          effortSelect("removed"),
        ]).toLiveConfiguration({ includeCatalog: false }),
      );
      yield* Fiber.join(sawM0Reset);

      // If m255 learns variant=v1 and a later probe starts on overflow m256 (displacing m255
      // from the capped 256-model probe list), m255 keeps its learned variant across re-probes.
      const sawM255Variant = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.models.at(-1)?.slug === "m255" &&
            snapshot.models.at(-1)?.isDefault === true &&
            snapshot.models
              .at(-1)
              ?.capabilities?.optionDescriptors?.some((d) => d.id === "variant") === true,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration([
          ...modelSelect("m255"),
          variantSelect,
        ]).toLiveConfiguration({ includeCatalog: false }),
      );
      yield* Fiber.join(sawM255Variant);
      // Clear only coordinator state so m255's variant can only survive via learnedModels.
      yield* coordinator.clearLiveConfiguration(identity.instanceId);
      yield* writeModels({
        models: modelIds,
        configOptions: [...modelSelect("m256")],
      });
      yield* TestClock.adjust("16 minutes");
      const probeOnOverflow = yield* waitForEnriched().pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const afterOverflowProbe = Option.getOrThrow(yield* Fiber.join(probeOnOverflow));
      expect(afterOverflowProbe.models.at(-1)?.slug).toBe("m256");

      yield* writeModels({
        models: modelIds,
        configOptions: [...modelSelect("m0")],
      });
      yield* TestClock.adjust("16 minutes");
      const probeRestored = yield* waitForEnriched().pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const afterRestoreProbe = Option.getOrThrow(yield* Fiber.join(probeRestored));
      expect(afterRestoreProbe.models.at(-1)?.slug).toBe("m255");
      expect(afterRestoreProbe.models[0]?.isDefault).toBe(true);
      expect(
        afterRestoreProbe.models
          .at(-1)
          ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
      ).toEqual([["variant", "v1"]]);

      // When a probe itself starts on overflow m256 while a live session is on m255,
      // probedCappedTailIsOverflow lets m255 stay visible and clears dropped options on update.
      const sawM255Selected = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models.at(-1)?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration([
          ...modelSelect("m255"),
          variantSelect,
        ]).toLiveConfiguration({ includeCatalog: false }),
      );
      yield* Fiber.join(sawM255Selected);
      yield* writeModels({
        models: modelIds,
        configOptions: [...modelSelect("m256")],
      });
      yield* TestClock.adjust("16 minutes");
      const probeOverflowWhileLiveM255 = yield* waitForEnriched().pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const afterProbeOverflowWhileLiveM255 = Option.getOrThrow(
        yield* Fiber.join(probeOverflowWhileLiveM255),
      );
      expect(afterProbeOverflowWhileLiveM255.models.at(-1)?.slug).toBe("m255");
      expect(afterProbeOverflowWhileLiveM255.models.at(-1)?.isDefault).toBe(true);
      expect(
        afterProbeOverflowWhileLiveM255.models
          .at(-1)
          ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
      ).toEqual([["variant", "v1"]]);
      const sawVariantCleared = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.models.at(-1)?.slug === "m255" &&
            (snapshot.models.at(-1)?.capabilities?.optionDescriptors?.length ?? 0) === 0,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(modelSelect("m255")).toLiveConfiguration({
          includeCatalog: false,
        }),
      );
      yield* Fiber.join(sawVariantCleared);

      // Sync overflow-tail tag with acceptedCatalog in both directions when managedProvider
      // deduplicates a structurally equal catalog publish ([m0..m254, m256]).
      const fullChoices = modelIds.map((value, index) => ({ value, name: `Model ${index}` }));
      const withoutM255Choices = fullChoices.filter((choice) => choice.value !== "m255");
      const selectFrom = (
        currentValue: string,
        options: ReadonlyArray<{ value: string; name: string }>,
      ) => [
        {
          id: "model",
          name: "Model",
          category: "model" as const,
          type: "select" as const,
          currentValue,
          options: [...options],
        },
      ];
      // Untagged base m256 -> tagged overflow m256 (deduplicated) -> m0 must restore m255.
      const sawBaseM256 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models.at(-1)?.slug === "m256"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(
          selectFrom("m256", withoutM255Choices),
        ).toLiveConfiguration({ includeCatalog: true }),
      );
      yield* Fiber.join(sawBaseM256);
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(selectFrom("m256", fullChoices)).toLiveConfiguration({
          includeCatalog: true,
        }),
      );
      const sawRestoredM255 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models[0]?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(selectFrom("m0", fullChoices)).toLiveConfiguration({
          includeCatalog: false,
        }),
      );
      expect(Option.getOrThrow(yield* Fiber.join(sawRestoredM255)).models.at(-1)?.slug).toBe(
        "m255",
      );

      // Tagged overflow m256 -> untagged base m256 (deduplicated) -> m0 -> stale C1 m1 keeps m256.
      const sawOverflowM256 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models.at(-1)?.slug === "m256"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(selectFrom("m256", fullChoices)).toLiveConfiguration({
          includeCatalog: true,
        }),
      );
      yield* Fiber.join(sawOverflowM256);
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(
          selectFrom("m256", withoutM255Choices),
        ).toLiveConfiguration({ includeCatalog: true }),
      );
      const sawUntaggedM0 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models[0]?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(
          selectFrom("m0", withoutM255Choices),
        ).toLiveConfiguration({ includeCatalog: false }),
      );
      yield* Fiber.join(sawUntaggedM0);
      const sawUntaggedM1 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models[1]?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(selectFrom("m1", fullChoices)).toLiveConfiguration({
          includeCatalog: false,
        }),
      );
      expect(Option.getOrThrow(yield* Fiber.join(sawUntaggedM1)).models.at(-1)?.slug).toBe("m256");

      // Non-recording replay during commitEnrichment must not revert a freshly tagged catalog
      // back to an older untagged acceptedCatalog entry before replaying a follow-up m0 update.
      const sawBaseM256BeforeReplay = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models.at(-1)?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(
          selectFrom("m256", withoutM255Choices),
        ).toLiveConfiguration({ includeCatalog: true }),
      );
      yield* Fiber.join(sawBaseM256BeforeReplay);
      const firstM0DuringCommit = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models[0]?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      blockOverflowWatcher = true;
      afterOverflowCacheReadHook = coordinator
        .publishLiveConfiguration(
          identity.instanceId,
          prepareAcpRegistryLiveConfiguration(selectFrom("m256", fullChoices)).toLiveConfiguration({
            includeCatalog: true,
          }),
        )
        .pipe(
          Effect.andThen(
            coordinator.publishLiveConfiguration(
              identity.instanceId,
              prepareAcpRegistryLiveConfiguration(
                selectFrom("m0", fullChoices),
              ).toLiveConfiguration({ includeCatalog: false }),
            ),
          ),
        );
      yield* instance.snapshot.refresh;
      const replayedM0 = Option.getOrThrow(yield* Fiber.join(firstM0DuringCommit));
      expect(replayedM0.models.at(-1)?.slug).toBe("m255");
      // Releasing the blocked watcher must not flicker back to the older m256 revision already
      // superseded by the cache-hit replay; only newer revisions (m1) should publish afterward.
      const seenAfterRelease: Array<readonly [string | undefined, string | undefined]> = [];
      const sawDrainedM1 = yield* instance.snapshot.streamChanges.pipe(
        Stream.tap((snapshot) =>
          Effect.sync(() => {
            seenAfterRelease.push([
              snapshot.models.find((m) => m.isDefault === true)?.slug,
              snapshot.models.at(-1)?.slug,
            ]);
          }),
        ),
        Stream.filter((snapshot) => snapshot.models[1]?.isDefault === true),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseOverflowWatcher, undefined);
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(selectFrom("m1", fullChoices)).toLiveConfiguration({
          includeCatalog: false,
        }),
      );
      yield* Fiber.join(sawDrainedM1);
      expect(seenAfterRelease).toEqual([["m1", "m255"]]);
    }),
  );

  it.effect(
    "retains all models' pending options across probe clear and keeps cache-hit commits consistent with concurrent live updates",
    () =>
      Effect.gen(function* () {
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const watcherBlocked = yield* Deferred.make<void>();
        const releaseWatcher = yield* Deferred.make<void>();
        const cacheHitRead = yield* Deferred.make<void>();
        const releaseCacheHit = yield* Deferred.make<void>();
        const cacheHitInCommit = yield* Deferred.make<void>();
        let gateProbe = false;
        let blockWatcher = false;
        let gateAfterCacheRead = false;
        let trackCacheHitCommit = false;
        let beforeClearHook: Effect.Effect<void> | null = null;
        const { coordinator, instance, waitForEnriched, writeModels } = yield* setupPeriodicDriver({
          prefix: "acp-driver-multi-clear-",
          initialModels: ["model-a", "model-b"],
          wrapCoordinator: (base) => ({
            ...base,
            clearLiveConfigurationIfRevision: (instanceId, options) => {
              const hook = beforeClearHook;
              beforeClearHook = null;
              return (hook ?? Effect.void).pipe(
                Effect.andThen(base.clearLiveConfigurationIfRevision(instanceId, options)),
              );
            },
            getUrlAuthAction: (instanceId) =>
              (trackCacheHitCommit
                ? Effect.sync(() => {
                    trackCacheHitCommit = false;
                  }).pipe(Effect.andThen(Deferred.succeed(cacheHitInCommit, undefined)))
                : Effect.void
              ).pipe(Effect.andThen(base.getUrlAuthAction(instanceId))),
            runBackgroundProbe: (agentId, effect) =>
              base.runBackgroundProbe(
                agentId,
                gateProbe
                  ? Effect.sync(() => {
                      gateProbe = false;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(probeStarted, undefined)),
                      Effect.andThen(Deferred.await(releaseProbe)),
                      Effect.andThen(effect),
                    )
                  : gateAfterCacheRead
                    ? Effect.sync(() => {
                        gateAfterCacheRead = false;
                      }).pipe(
                        Effect.andThen(effect),
                        Effect.tap(() =>
                          Deferred.succeed(cacheHitRead, undefined).pipe(
                            Effect.andThen(Deferred.await(releaseCacheHit)),
                          ),
                        ),
                      )
                    : effect,
              ),
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) =>
                  blockWatcher
                    ? Effect.sync(() => {
                        blockWatcher = false;
                      }).pipe(
                        Effect.andThen(Deferred.succeed(watcherBlocked, undefined)),
                        Effect.andThen(Deferred.await(releaseWatcher)),
                        Effect.andThen(onUpdate(configuration, revision)),
                      )
                    : onUpdate(configuration, revision),
                options,
              ),
          }),
        });
        const effortOpt = (currentValue: "low" | "high") => ({
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue,
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        });
        const variantOpt = {
          id: "variant",
          label: "Variant",
          type: "select" as const,
          currentValue: "v1",
          options: [{ id: "v1", label: "V1" }],
        };

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        // Publish live catalog [model-a, model-b], then start a gated superseding probe.
        const sawCatalog = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "model-a")
                ?.capabilities?.optionDescriptors?.some((d) => d.id === "effort") === true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "model-a", name: "Model A", description: null },
            { id: "model-b", name: "Model B", description: null },
          ],
          currentModelId: "model-a",
          configOptions: [effortOpt("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(sawCatalog);

        yield* writeModels({
          models: ["model-a", "model-b"],
          configOptions: [
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "low",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
        });
        yield* TestClock.adjust("16 minutes");
        gateProbe = true;
        const probeDone = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(probeStarted);

        // Block the watcher so neither model-b nor model-a is applied before the probe clears.
        blockWatcher = true;
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-b",
          configOptions: [variantOpt],
          modelOptionIds: ["variant"],
          modelsFromModelSelect: false,
        });
        yield* Deferred.await(watcherBlocked);
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [effortOpt("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });

        // Release probe before watcher resumes: clearLiveConfigurationIfRevision must retain
        // both model-b (variant=v1) and model-a (effort=high) across commit and later refreshes.
        yield* Deferred.succeed(releaseProbe, undefined);
        const afterProbe = Option.getOrThrow(yield* Fiber.join(probeDone));
        expect(
          afterProbe.models
            .find((m) => m.slug === "model-b")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["variant", "v1"]]);
        expect(
          afterProbe.models
            .find((m) => m.slug === "model-a")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "high"]]);
        yield* Deferred.succeed(releaseWatcher, undefined);

        const afterProbeRefresh = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const refreshedAfterProbe = Option.getOrThrow(yield* Fiber.join(afterProbeRefresh));
        expect(
          refreshedAfterProbe.models
            .find((m) => m.slug === "model-b")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["variant", "v1"]]);
        expect(
          refreshedAfterProbe.models
            .find((m) => m.slug === "model-a")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "high"]]);

        // Pre-learn effort=[low] on model-b, then run a superseding probe without reasoning on
        // model-b while blocked updates widen model-b's variant to [v1, v2] (v2) and advertise
        // effort=[high] on model-b; older learned schemas must not reject either retained update.
        const effortLowOnly = {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue: "low",
          options: [{ id: "low", label: "Low" }],
        };
        const effortHighOnly = {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue: "high",
          options: [{ id: "high", label: "High" }],
        };
        const variantWidened = {
          id: "variant",
          label: "Variant",
          type: "select" as const,
          currentValue: "v2",
          options: [
            { id: "v1", label: "V1" },
            { id: "v2", label: "V2" },
          ],
        };
        const sawLearnedBLow = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "model-b")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
              "low",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "model-a",
          configOptions: [effortOpt("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
          advertisedReasoning: { "model-b": effortLowOnly },
        });
        yield* Fiber.join(sawLearnedBLow);

        yield* writeModels(["model-a", "model-b"]);
        yield* TestClock.adjust("16 minutes");
        beforeClearHook = coordinator
          .publishLiveConfiguration(identity.instanceId, {
            models: [],
            currentModelId: "model-b",
            configOptions: [variantWidened],
            modelOptionIds: ["variant"],
            modelsFromModelSelect: false,
          })
          .pipe(
            Effect.andThen(
              coordinator.publishLiveConfiguration(identity.instanceId, {
                models: [],
                currentModelId: "model-a",
                configOptions: [],
                modelOptionIds: [],
                modelsFromModelSelect: false,
                advertisedReasoning: { "model-b": effortHighOnly },
              }),
            ),
          );
        const secondProbeDone = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const afterWidenedProbe = Option.getOrThrow(yield* Fiber.join(secondProbeDone));
        expect(
          afterWidenedProbe.models
            .find((m) => m.slug === "model-b")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([
          ["variant", "v2"],
          ["effort", "high"],
        ]);

        // Verify a cache-hit commit (probeOptions=null) whose watcher applies effort=high after
        // enrichProviderCached reads effort=low still publishes effort=high rather than reverting.
        const sawFreshCatalog = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((m) => m.slug === "fresh-b")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "fresh-a", name: "Fresh A", description: null },
            { id: "fresh-b", name: "Fresh B", description: null },
          ],
          currentModelId: "fresh-a",
          configOptions: [effortOpt("low")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(sawFreshCatalog);

        gateAfterCacheRead = true;
        yield* instance.snapshot.refresh;
        // Wait until enrichProviderCached has read effort=low from enrichmentCache, before commitEnrichment runs.
        yield* Deferred.await(cacheHitRead);

        const sawFreshHigh = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "fresh-a")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
              "high",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "fresh-a",
          configOptions: [effortOpt("high")],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(sawFreshHigh);

        // Release the cache-hit commit, wait until it enters commitEnrichment and drains
        // liveSnapshotSemaphore via a follow-up command publish, then inspect getSnapshot.
        trackCacheHitCommit = true;
        yield* Deferred.succeed(releaseCacheHit, undefined);
        yield* Deferred.await(cacheHitInCommit);
        const commitDrained = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "commit-drained"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "commit-drained" }],
          skills: [],
        });
        yield* Fiber.join(commitDrained);
        const afterCachedCommit = yield* instance.snapshot.getSnapshot;
        expect(
          afterCachedCommit.models
            .find((m) => m.slug === "fresh-a")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "high"]]);
      }),
  );

  it.effect(
    "preserves post-probe advertisedReasoning on newly appearing effort selectors and keeps live options on model-less probes",
    () =>
      Effect.gen(function* () {
        const meta = {
          reasoningEfforts: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        };
        const ids = ["a", "b", "c"];
        const entries = ids.map((id) => ({ modelId: id, name: id, _meta: meta }));
        const modelSelect = (currentValue: string) => ({
          id: "model",
          name: "Model",
          category: "model" as const,
          type: "select" as const,
          currentValue,
          options: ids.map((value) => ({ value, name: value })),
        });
        const effortSelect = (currentValue: "low" | "high") => ({
          id: "effort",
          name: "Effort",
          category: "thought_level" as const,
          type: "select" as const,
          currentValue,
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        });

        let blockReasoningWatcher = false;
        let releaseReasoningWatcher = yield* Deferred.make<void>();
        let gateProbeResolve = false;
        const probeResolveEntered = yield* Deferred.make<void>();
        const releaseProbeResolve = yield* Deferred.make<void>();
        const { coordinator, instance, waitForEnriched, writeModels } = yield* setupPeriodicDriver({
          prefix: "acp-driver-advertised-reasoning-",
          initialModels: {
            models: entries,
            configOptions: [modelSelect("a")],
          },
          onResolve: () =>
            gateProbeResolve
              ? Effect.sync(() => {
                  gateProbeResolve = false;
                }).pipe(
                  Effect.andThen(Deferred.succeed(probeResolveEntered, undefined)),
                  Effect.andThen(Deferred.await(releaseProbeResolve)),
                )
              : Effect.void,
          wrapCoordinator: (base) => ({
            ...base,
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) => {
                  if (!blockReasoningWatcher) return onUpdate(configuration, revision);
                  blockReasoningWatcher = false;
                  const gate = releaseReasoningWatcher;
                  return Deferred.await(gate).pipe(
                    Effect.andThen(onUpdate(configuration, revision)),
                  );
                },
                options,
              ),
          }),
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          prepareAcpRegistryLiveConfiguration([modelSelect("a")], undefined, {
            currentModelId: "a",
            availableModels: entries,
          }).toLiveConfiguration({ includeCatalog: true }),
        );
        yield* TestClock.adjust("16 minutes");
        const superseded = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(superseded);

        // After a superseding probe without effort, an options-only update introducing effort
        // must project effort=high onto a and advertisedReasoning onto b and c.
        const sawAdvertised = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "a")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
                "high" &&
              snapshot.models
                .find((m) => m.slug === "b")
                ?.capabilities?.optionDescriptors?.some((d) => d.id === "effort") === true,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          prepareAcpRegistryLiveConfiguration([modelSelect("a"), effortSelect("high")], undefined, {
            currentModelId: "a",
            availableModels: entries,
          }).toLiveConfiguration({ includeCatalog: false }),
        );
        const afterAdvertised = Option.getOrThrow(yield* Fiber.join(sawAdvertised));
        expect(
          afterAdvertised.models
            .find((m) => m.slug === "c")
            ?.capabilities?.optionDescriptors?.some((d) => d.id === "effort"),
        ).toBe(true);

        // When c advertises effort=high for b and then sends a follow-up update without b metadata
        // before the watcher drains, readiness replay (with foreground startup suppressing the
        // probe) must still deliver b's effort=high without stealing default from c.
        const lowOnlyEffort = {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue: "low",
          options: [{ id: "low", label: "Low" }],
        };
        const highEffort = {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          role: "reasoning" as const,
          currentValue: "high",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        };
        const sawNarrowLiveCatalog = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => {
            const bEffort = snapshot.models
              .find((m) => m.slug === "b")
              ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort");
            return bEffort?.type === "select" && bEffort.options.length === 1;
          }),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [
            { id: "a", name: "a", description: null },
            { id: "b", name: "b", description: null, reasoningEffort: lowOnlyEffort },
            { id: "c", name: "c", description: null },
          ],
          currentModelId: "a",
          configOptions: [],
          modelsFromModelSelect: true,
        });
        yield* Fiber.join(sawNarrowLiveCatalog);

        blockReasoningWatcher = true;
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "c",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { b: highEffort },
        });
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "c",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        const sawReadinessOrphanedReasoning = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models.find((m) => m.slug === "c")?.isDefault === true &&
              snapshot.models
                .find((m) => m.slug === "b")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
                "high",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.withForegroundStartup(
          "test-agent",
          instance.snapshot.refresh.pipe(Effect.andThen(Fiber.join(sawReadinessOrphanedReasoning))),
        );
        yield* Deferred.succeed(releaseReasoningWatcher, undefined);
        const afterOrphanedReadiness = yield* instance.snapshot.getSnapshot;
        expect(afterOrphanedReadiness.models.find((m) => m.slug === "c")?.isDefault).toBe(true);
        expect(
          afterOrphanedReadiness.models
            .find((m) => m.slug === "b")
            ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort"),
        ).toEqual(highEffort);

        // If c advertises effort=high for b and b later reports an empty full option set,
        // the live watcher immediately removes b's old selector and a superseding probe selecting
        // b without reasoning must not restore high.
        const modeSelect = {
          id: "mode",
          name: "Mode",
          category: "mode" as const,
          type: "select" as const,
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        };
        const modeOption = {
          id: "mode",
          label: "Mode",
          type: "select" as const,
          currentValue: "ask",
          options: [{ id: "ask", label: "Ask" }],
        };
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "c",
          configOptions: [modeOption],
          modelOptionIds: [],
          modelsFromModelSelect: false,
          advertisedReasoning: { b: highEffort },
        });
        const sawBDroppedEffort = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models.find((m) => m.slug === "b")?.isDefault === true &&
              (snapshot.models
                .find((m) => m.slug === "b")
                ?.capabilities?.optionDescriptors?.some((d) => d.id === "effort") ?? false) ===
                false,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "b",
          configOptions: [],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* Fiber.join(sawBDroppedEffort);
        yield* writeModels({
          models: ids.map((id) => ({ modelId: id, name: id })),
          configOptions: [modelSelect("b"), modeSelect],
        });
        yield* TestClock.adjust("16 minutes");
        const probeAfterBDropped = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const afterBDroppedProbe = Option.getOrThrow(yield* Fiber.join(probeAfterBDropped));
        expect(afterBDroppedProbe.models.find((m) => m.slug === "b")?.isDefault).toBe(true);
        expect(
          afterBDroppedProbe.models
            .find((m) => m.slug === "b")
            ?.capabilities?.optionDescriptors?.some((d) => d.id === "effort") ?? false,
        ).toBe(false);

        // When b previously learned effort=high and reports a full update removing effort while
        // a superseding probe selecting a runs before the watcher drains, probe retention preserves
        // replacement intent so b's omitted effort is removed while c keeps its learned effort.
        const sawBLearnedAndCLearned = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "b")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
                "high" &&
              snapshot.models
                .find((m) => m.slug === "c")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
                "high",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "b",
          configOptions: [modeOption, highEffort],
          modelOptionIds: ["effort"],
          modelsFromModelSelect: false,
          advertisedReasoning: { c: highEffort },
        });
        yield* Fiber.join(sawBLearnedAndCLearned);

        yield* writeModels({
          models: ids.map((id) => ({ modelId: id, name: id })),
          configOptions: [modelSelect("a"), modeSelect],
        });
        yield* TestClock.adjust("16 minutes");
        gateProbeResolve = true;
        const probeConsumedRemoval = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        const refreshFiber = yield* instance.snapshot.refresh.pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        // Wait until readiness has finished and the probe is in flight before publishing b's
        // removal and a's selection, so readiness cannot replay them ahead of probe retention.
        yield* Deferred.await(probeResolveEntered);
        releaseReasoningWatcher = yield* Deferred.make<void>();
        blockReasoningWatcher = true;
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "b",
          configOptions: [modeOption],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* coordinator.publishLiveConfiguration(identity.instanceId, {
          models: [],
          currentModelId: "a",
          configOptions: [modeOption],
          modelOptionIds: [],
          modelsFromModelSelect: false,
        });
        yield* Deferred.succeed(releaseProbeResolve, undefined);
        yield* Fiber.join(refreshFiber);
        const afterProbeConsumedRemoval = Option.getOrThrow(
          yield* Fiber.join(probeConsumedRemoval),
        );
        yield* Deferred.succeed(releaseReasoningWatcher, undefined);
        expect(afterProbeConsumedRemoval.models.find((m) => m.slug === "a")?.isDefault).toBe(true);
        expect(
          afterProbeConsumedRemoval.models
            .find((m) => m.slug === "b")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["mode", "ask"]]);
        expect(
          afterProbeConsumedRemoval.models
            .find((m) => m.slug === "c")
            ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue,
        ).toBe("high");

        // When neither live state nor a fresh probe advertises models, keep live reasoning
        // options on the synthetic default model instead of clearing them.
        yield* writeModels({ provisional: "" });
        yield* coordinator.clearLiveConfiguration(identity.instanceId);
        yield* instance.invalidateCaches ?? Effect.void;
        const modelLessInitial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(modelLessInitial);

        const sawSyntheticEffort = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((m) => m.slug === "default")
                ?.capabilities?.optionDescriptors?.find((d) => d.id === "effort")?.currentValue ===
              "high",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          prepareAcpRegistryLiveConfiguration([effortSelect("high")]).toLiveConfiguration({
            includeCatalog: false,
          }),
        );
        yield* Fiber.join(sawSyntheticEffort);

        yield* TestClock.adjust("1 minute");
        const modelLessRetry = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const afterEmptyRetry = Option.getOrThrow(yield* Fiber.join(modelLessRetry));
        expect(
          afterEmptyRetry.models
            .find((m) => m.slug === "default")
            ?.capabilities?.optionDescriptors?.map((d) => [d.id, d.currentValue]),
        ).toEqual([["effort", "high"]]);
      }),
  );
});
