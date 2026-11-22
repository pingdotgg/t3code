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
  acpRegistryProbeSupersedesLiveCatalog,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
  isAcpRegistryCacheValid,
  retainAcpRegistryLiveOptionsAfterProbe,
  updateAcpRegistryEnrichmentCache,
} from "./driver.ts";
import {
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
    expect(
      acpRegistryProbeSupersedesLiveCatalog({
        probedModelCount: 0,
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

    // Drops reasoning when the probe disables it and returns none when no live option survives.
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
    ).toEqual(Option.none());

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

    // Never promotes a live model-specific option into a probe-shared option across models.
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
    ).toEqual(Option.none());
  });
});

describe("prepareAcpRegistryLiveConfiguration", () => {
  it("ignores in-cap selection and effort selector toggles while detecting overflow selection, renames, and projecting newly normalized per-model reasoning", () => {
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
    expect(prepareAcpRegistryLiveConfiguration(modelSelect("m256", choices)).catalogKey).not.toBe(
      keyM0,
    );
    expect(
      prepareAcpRegistryLiveConfiguration(
        modelSelect("m0", [{ value: "m0", name: "Model 0 Renamed" }, ...choices.slice(1)]),
      ).catalogKey,
    ).not.toBe(keyM0);

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
      result: { protocolVersion: 1, agentCapabilities: { providers: {} }, authMethods: [], agentInfo: { name: "fake", version: "1.5.9" } },
    });
  } else if (method === "session/new") {
    const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
    if (!Array.isArray(payload) && typeof payload.provisional === "string") {
      send({
        id,
        result: {
          sessionId: "probe-session",
          models: {
            currentModelId: payload.provisional,
            availableModels: [{ modelId: payload.provisional, name: payload.provisional }],
          },
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: payload.provisional,
              options: [
                { value: payload.provisional, name: payload.provisional },
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

  it.effect("drops cached and session-reported models when its caches are invalidated", () =>
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
              options: [{ value: "on", name: "On" }],
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
      // reconcile against the replacement probe's schema (keeping fast and dropping legacy).
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        prepareAcpRegistryLiveConfiguration(
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
        ).toLiveConfiguration({ includeCatalog: false }),
      );
      // Force a cached refresh so the semaphore-serialized watcher has finished before reading.
      const synced = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const afterOptions = Option.getOrThrow(yield* Fiber.join(synced));
      expect(afterOptions.models.map((model) => model.slug)).toEqual(["old-model", "new-model"]);
      expect(
        afterOptions.models
          .find((model) => model.slug === "old-model")
          ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
      ).toEqual([["fast", "on"]]);

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
      const emptyProbeAfterInvalidate = yield* waitForModels(["session-x", "session-y"]).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      expect(Option.isSome(yield* Fiber.join(emptyProbeAfterInvalidate))).toBe(true);
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
    readonly inspect?: () => AcpRegistrySupport.AcpRegistryInspection;
    readonly onResolve?: () => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: options.prefix });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(options.initialModels));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const effectiveCoordinator =
        options.wrapCoordinator === undefined ? coordinator : options.wrapCoordinator(coordinator);
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
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
      return {
        directory,
        coordinator,
        instance,
        waitForEnriched,
        writeModels,
        withBlockedForegroundStartup,
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
    "clears accepted state on unauthenticated probes (even with concurrent options updates), invalidation, and provider disable",
    () =>
      Effect.gen(function* () {
        const probeEntered = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const signOutRejected = yield* Deferred.make<void>();
        let gateNextResolve = false;
        let injectCatalogBeforeSignOutClear = false;
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
                return yield* base.clearLiveConfigurationIfRevision(instanceId, options);
              }),
          }),
          onResolve: () =>
            Effect.gen(function* () {
              if (gateNextResolve) {
                gateNextResolve = false;
                yield* Deferred.succeed(probeEntered, undefined);
                yield* Deferred.await(releaseProbe);
              }
            }),
        });

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(initial);

        // Unauthenticated post-TTL probe racing an options-only live update must still keep
        // status: warning, auth: unauthenticated, sign-in message, and models: ["default"].
        yield* writeModels({ fail: "Sign in required", code: -32000 });
        yield* TestClock.adjust("16 minutes");
        gateNextResolve = true;
        const signedOutProbe = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(probeEntered);

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

        yield* Deferred.succeed(releaseProbe, undefined);
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
        // coordinator state, clearLiveConfigurationIfRevision returns false and the stale
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
            watchLiveConfiguration: (instanceId, onUpdate, options) =>
              base.watchLiveConfiguration(
                instanceId,
                (configuration, revision) =>
                  blockHandoffWatcher && configuration.currentModelId === "handoff-a"
                    ? Effect.sync(() => {
                        blockHandoffWatcher = false;
                      }).pipe(
                        Effect.andThen(Deferred.succeed(handoffCallbackBlocked, undefined)),
                        Effect.andThen(Effect.never),
                      )
                    : onUpdate(configuration, revision),
                options,
              ),
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
        // before recording lastObservedLiveRevision, so a subsequent provisional probe keeps it.
        yield* instance.snapshot.refresh;
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
            yield* instance.snapshot.refresh;
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "handoff-a",
              "handoff-b",
            ]);
          }),
        );
      }),
  );
});
