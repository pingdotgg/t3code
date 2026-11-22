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

    // Options-only updates (includeCatalog: false) must also strip effort on a reasoning-disabled current model.
    const optionsOnlyDisabled = normalizeAcpRegistryLiveConfiguration(
      [effort],
      undefined,
      {
        currentModelId: "glm",
        availableModels: [
          { modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } },
          { modelId: "opus", name: "Opus" },
        ],
      },
      { includeCatalog: false },
    );
    expect(optionsOnlyDisabled.configOptions).toEqual([]);
    expect(optionsOnlyDisabled.modelOptionIds).toEqual([]);
    expect(optionsOnlyDisabled.reasoningDisabledModelIds).toEqual(["glm"]);
    const providerWithEffortOnGlm = applyAcpRegistryLiveConfiguration(
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
    expect(
      applyAcpRegistryLiveConfiguration(
        providerWithEffortOnGlm,
        optionsOnlyDisabled,
        [],
      ).models.map((model) => model.capabilities?.optionDescriptors ?? []),
    ).toEqual([[], []]);

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

    const optionsOnly = normalizeAcpRegistryLiveConfiguration(
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
      { includeCatalog: false },
    );
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
  it("retains valid live option values across a superseding probe while dropping removed or disabled options", () => {
    const mode = (currentValue: "ask" | "code") => ({
      id: "mode",
      label: "Mode",
      type: "select" as const,
      currentValue,
      options: [
        { id: "ask", label: "Ask" },
        { id: "code", label: "Code" },
      ],
    });
    const effort = (currentValue: "low" | "high") => ({
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
    const legacy = {
      id: "legacy",
      label: "Legacy",
      type: "select" as const,
      currentValue: "on",
      options: [{ id: "on", label: "On" }],
    };
    const fast = { id: "fast", label: "Fast", type: "boolean" as const, currentValue: false };

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
        configOptions: [mode("ask"), fast, effort("high")],
        modelOptionIds: new Set(["effort"]),
      },
    );
    expect(retained).toEqual(
      Option.some({
        models: [],
        currentModelId: "old-model",
        configOptions: [mode("code"), fast, effort("low")],
        modelOptionIds: ["effort"],
        modelsFromModelSelect: false,
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
        normalizeAcpRegistryLiveConfiguration([], undefined, {
          currentModelId: "old-model",
          availableModels: [
            { modelId: "old-model", name: "old-model" },
            { modelId: "session-model", name: "session-model" },
          ],
        }),
      );
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "new-model"]));

      const refreshed = yield* waitForModels(["old-model", "new-model"]).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      expect(Option.isSome(yield* Fiber.join(refreshed))).toBe(true);
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
          effortValue: "low" | "high" = "high",
          options?: { readonly includeCatalog?: boolean; readonly includeLegacy?: boolean },
        ) =>
          normalizeAcpRegistryLiveConfiguration(
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
              ],
            },
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

        // Upstream adds a model, removes the shared legacy option, and disables reasoning on other-model.
        yield* writeModels([
          "new-model",
          "old-model",
          {
            modelId: "other-model",
            name: "other-model",
            _meta: { supportsReasoningEffort: false },
          },
        ]);
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
        // old-model keeps its live effort value (low) while legacy is dropped and other-model has no effort.
        expect(
          updated.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([["effort", "low"]]);
        expect(
          updated.models
            .find((model) => model.slug === "other-model")
            ?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
        ).toEqual([]);
        expect(
          updated.models
            .find((model) => model.slug === "new-model")
            ?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
        ).toEqual(["effort"]);
        // Coordinator retains live option values (with models stripped) for Copilot unsetOptionDefaults.
        expect(
          Option.map(yield* coordinator.getLiveConfiguration(identity.instanceId), (config) => ({
            models: config.models,
            effort: config.configOptions.find((option) => option.id === "effort")?.currentValue,
          })),
        ).toEqual(Option.some({ models: [], effort: "low" }));

        // A mid-session option update (includeCatalog: false) keeps the newly probed catalog intact.
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
          sessionWithOptions("old-model", "high", { includeCatalog: false }),
        );
        expect(
          Option.getOrThrow(yield* Fiber.join(effortUpdated)).models.map((model) => model.slug),
        ).toEqual(["new-model", "old-model", "other-model"]);

        // Cached refresh must reuse the cached catalog without re-probing.
        yield* writeModels(["unexpected-reprobe", "other-model"]);
        const nextCached = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(nextCached)).models.map((model) => model.slug),
        ).toEqual(["new-model", "old-model", "other-model"]);

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
        let gateNextResolve = false;
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

        // Re-populate the catalog, then verify disableProvider clears acceptedCatalog so a
        // provisional probe afterward does not stick to the disabled provider's models.
        yield* writeModels(["new-model", "old-model", "other-model"]);
        const restored = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(restored);

        yield* instance.acpSessionManagement!.disableProvider({
          cwd: directory,
          providerId: "old-provider",
        });
        yield* writeModels({ provisional: "placeholder" });
        const afterDisable = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(afterDisable)).models.map((model) => model.slug),
        ).toEqual(["placeholder"]);

        // Re-populate, then verify invalidateCaches and auth.invalidate clear acceptedCatalog.
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
        yield* withBlockedForegroundStartup(
          Effect.gen(function* () {
            yield* instance.auth?.invalidate ?? Effect.void;
            expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
              "default",
            ]);
          }),
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
    "commits a fresh post-TTL catalog when only an options-only live update arrives in flight while enforcing disabled reasoning",
    () =>
      Effect.gen(function* () {
        const secondProbeEntered = yield* Deferred.make<void>();
        const releaseSecondProbe = yield* Deferred.make<void>();
        let gateNextResolve = false;

        const {
          coordinator,
          instance,
          waitForEnriched,
          writeModels,
          withBlockedForegroundStartup,
        } = yield* setupPeriodicDriver({
          prefix: "acp-driver-inflight-options-",
          initialModels: ["old-model", "other-model"],
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

        // Fresh probe disables reasoning on old-model while adding new-model.
        yield* writeModels([
          { modelId: "old-model", name: "old-model", _meta: { supportsReasoningEffort: false } },
          "other-model",
          "new-model",
        ]);
        yield* TestClock.adjust("16 minutes");
        gateNextResolve = true;
        yield* instance.snapshot.refresh;
        yield* Deferred.await(secondProbeEntered);

        const optionsApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.models
                .find((model) => model.slug === "old-model")
                ?.capabilities?.optionDescriptors?.find((option) => option.id === "mode")
                ?.currentValue === "plan",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
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
        yield* Fiber.join(optionsApplied);

        const committed = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseSecondProbe, undefined);
        const updated = Option.getOrThrow(yield* Fiber.join(committed));
        expect(updated.models.map((model) => model.slug)).toEqual([
          "old-model",
          "other-model",
          "new-model",
        ]);
        // Unrelated live option (mode) stays applied while disabled reasoning (effort) stays stripped.
        expect(
          updated.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => [option.id, option.currentValue]),
        ).toEqual([["mode", "plan"]]);

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
        expect(
          Option.getOrThrow(yield* Fiber.join(cached)).models.map((model) => model.slug),
        ).toEqual(["old-model", "other-model", "new-model"]);
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
});
