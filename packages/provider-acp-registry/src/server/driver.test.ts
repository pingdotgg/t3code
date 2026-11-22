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
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "fake", version: "1.5.9" } },
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
    const availableModels = payload.map((entry) =>
      typeof entry === "string" ? { modelId: entry, name: entry } : entry,
    );
    const hasMeta = availableModels.some((entry) => entry._meta !== undefined);
    send({
      id,
      result: {
        sessionId: "probe-session",
        models: {
          currentModelId: availableModels[0]?.modelId,
          availableModels,
        },
        ...(hasMeta
          ? {
              configOptions: [
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
            }
          : {}),
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
  it.effect(
    "picks up new models on a post-TTL refresh instead of reverting to an earlier session's catalog",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "acp-driver-periodic-",
        });
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

        const waitForEnriched = () =>
          instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
            Stream.runHead,
          );

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
                ?.capabilities?.optionDescriptors?.some((option) => option.id === "effort") ===
                true &&
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
          sessionWithOptions("old-model", "high", { includeLegacy: true }),
        );
        yield* Fiber.join(learnedEffort);

        // Upstream adds a model, removes the shared legacy option, and disables reasoning on other-model.
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify([
            "new-model",
            "old-model",
            {
              modelId: "other-model",
              name: "other-model",
              _meta: { supportsReasoningEffort: false },
            },
          ]),
        );
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
        expect(
          updated.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.map((option) => option.id),
        ).toEqual(["effort"]);
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

        // A mid-session option update from a long-lived session (includeCatalog: false) must keep
        // the newly probed models intact while updating the active model's learned options.
        const effortUpdated = yield* instance.snapshot.streamChanges.pipe(
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
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          sessionWithOptions("old-model", "low", { includeCatalog: false }),
        );
        expect(
          Option.getOrThrow(yield* Fiber.join(effortUpdated)).models.map((model) => model.slug),
        ).toEqual(["new-model", "old-model", "other-model"]);

        // Subsequent cached refresh must keep the cached catalog instead of re-probing or reverting to old session state.
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["unexpected-reprobe", "other-model"]),
        );
        const nextCached = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(nextCached)).models.map((model) => model.slug),
        ).toEqual(["new-model", "old-model", "other-model"]);

        // When a later post-TTL probe runs directly on old-model without effort, learned effort is dropped.
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "new-model"]));
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
    "retains accepted models across provisional probes, transient errors, and foreground startup, and drops them on sign-out or invalidation",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "acp-driver-retention-",
        });
        const agentPath = path.join(directory, "agent.mjs");
        const modelsPath = path.join(directory, "models.json");
        yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["new-model", "old-model", "other-model"]),
        );
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

        const waitForEnriched = () =>
          instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
            Stream.runHead,
          );

        const initial = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(initial)).models.map((model) => model.slug),
        ).toEqual(["new-model", "old-model", "other-model"]);

        // When a settled live catalog beats a provisional probe, the enrichment cache must store
        // the winning live catalog (not the rejected provisional probe) so a subsequent options-only
        // update and cached refresh within the 30s retry TTL do not regress to the placeholder.
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

        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify({ provisional: "placeholder" }),
        );
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
        const cachedWithinRetryTtl = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(cachedWithinRetryTtl)).models.map(
            (model) => model.slug,
          ),
        ).toEqual(["live-a", "live-b"]);

        // A provisional probe must still use the short retry TTL even when it retains a multi-model catalog.
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["new-model", "old-model", "other-model", "settled-model"]),
        );
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

        // A transient discovery failure after TTL expiry must preserve its warning/message even
        // when an options-only live configuration exists, while keeping accepted models and live options.
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
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
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
        yield* Fiber.join(optionsBeforeFailure);

        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify({ fail: "Temporary discovery outage" }),
        );
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
          "settled-model",
        ]);
        expect(
          warned.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
            ?.currentValue,
        ).toBe("low");

        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["new-model", "old-model", "other-model", "settled-model"]),
        );
        const recovered = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(
          Option.getOrThrow(yield* Fiber.join(recovered)).models.map((model) => model.slug),
        ).toEqual(["new-model", "old-model", "other-model", "settled-model"]);

        // An unauthenticated post-TTL probe must clear accepted models so subsequent readiness
        // refreshes do not flip between the signed-in catalog and default.
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify({ fail: "Sign in required", code: -32000 }),
        );
        yield* TestClock.adjust("16 minutes");
        const signedOutProbe = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const signedOut = Option.getOrThrow(yield* Fiber.join(signedOutProbe));
        expect(signedOut.models.map((model) => model.slug)).toEqual(["default"]);

        const startupEntered = yield* Deferred.make<void>();
        const releaseStartup = yield* Deferred.make<void>();
        const startup = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(startupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStartup)),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(startupEntered);

        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "default",
        ]);
        yield* Deferred.succeed(releaseStartup, undefined);
        yield* Fiber.join(startup);

        // Re-populate the catalog, then verify foreground startup keeps it and invalidation clears it.
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["new-model", "old-model", "other-model", "settled-model"]),
        );
        const restored = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(restored);

        const startupEntered2 = yield* Deferred.make<void>();
        const releaseStartup2 = yield* Deferred.make<void>();
        const startup2 = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(startupEntered2, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStartup2)),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(startupEntered2);

        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "new-model",
          "old-model",
          "other-model",
          "settled-model",
        ]);

        yield* instance.invalidateCaches ?? Effect.void;
        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "default",
        ]);

        yield* Deferred.succeed(releaseStartup2, undefined);
        yield* Fiber.join(startup2);

        const restoredForAuthInvalidate = yield* waitForEnriched().pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(restoredForAuthInvalidate);

        const startupEntered3 = yield* Deferred.make<void>();
        const releaseStartup3 = yield* Deferred.make<void>();
        const startup3 = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(startupEntered3, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStartup3)),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(startupEntered3);

        yield* instance.auth?.invalidate ?? Effect.void;
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "default",
        ]);

        yield* Deferred.succeed(releaseStartup3, undefined);
        yield* Fiber.join(startup3);
      }),
  );

  it.effect("keeps a live session catalog published while a post-TTL probe is in flight", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "acp-driver-inflight-",
      });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "other-model"]));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const secondProbeEntered = yield* Deferred.make<void>();
      const releaseSecondProbe = yield* Deferred.make<void>();
      const secondProbeSettled = yield* Deferred.make<void>();
      let gateNextResolve = false;
      let secondProbeReleased = false;

      const observedCoordinator: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"] =
        {
          ...coordinator,
          runBackgroundProbe: (agentId, effect) =>
            Effect.suspend(() => {
              const armedBefore = gateNextResolve;
              return coordinator
                .runBackgroundProbe(agentId, effect)
                .pipe(
                  Effect.tap(() =>
                    armedBefore && secondProbeReleased
                      ? Deferred.succeed(secondProbeSettled, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                );
            }),
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
          observedCoordinator,
        ),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.gen(function* () {
              if (gateNextResolve) {
                gateNextResolve = false;
                yield* Deferred.succeed(secondProbeEntered, undefined);
                yield* Deferred.await(releaseSecondProbe);
                secondProbeReleased = true;
              }
              return {
                distribution: "npx" as const,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              };
            }),
        }),
      );

      const initial = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(initial);

      yield* fileSystem.writeFileString(
        modelsPath,
        JSON.stringify(["old-model", "other-model", "stale-probe-model"]),
      );
      yield* TestClock.adjust("16 minutes");
      gateNextResolve = true;
      yield* instance.snapshot.refresh;
      yield* Deferred.await(secondProbeEntered);

      const liveApplied = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models.map((m) => m.slug).join() === "entitled-model"),
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
      // Wait for the competing probe's commit-or-discard step to settle before asserting or refreshing.
      yield* Deferred.await(secondProbeSettled);
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

      yield* fileSystem.writeFileString(modelsPath, JSON.stringify({ provisional: "placeholder" }));
      yield* TestClock.adjust("16 minutes");
      const afterProvisionalProbe = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
        Stream.runHead,
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
    "commits a fresh post-TTL catalog when only an options-only live update arrives in flight",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "acp-driver-inflight-options-",
        });
        const agentPath = path.join(directory, "agent.mjs");
        const modelsPath = path.join(directory, "models.json");
        yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "other-model"]));
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const secondProbeEntered = yield* Deferred.make<void>();
        const releaseSecondProbe = yield* Deferred.make<void>();
        let gateNextResolve = false;

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
              Effect.gen(function* () {
                if (gateNextResolve) {
                  gateNextResolve = false;
                  yield* Deferred.succeed(secondProbeEntered, undefined);
                  yield* Deferred.await(releaseSecondProbe);
                }
                return {
                  distribution: "npx" as const,
                  spawn: { command: process.execPath, args: [agentPath, modelsPath] },
                };
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
        gateNextResolve = true;
        yield* instance.snapshot.refresh;
        yield* Deferred.await(secondProbeEntered);

        const optionsApplied = yield* instance.snapshot.streamChanges.pipe(
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
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
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
        expect(
          updated.models
            .find((model) => model.slug === "old-model")
            ?.capabilities?.optionDescriptors?.find((option) => option.id === "effort")
            ?.currentValue,
        ).toBe("low");

        // Verify the fresh catalog was saved to acceptedCatalog (survives skipped readiness) and cache.
        const startupEntered = yield* Deferred.make<void>();
        const releaseStartup = yield* Deferred.make<void>();
        const startup = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(startupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseStartup)),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(startupEntered);

        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshot.getSnapshot).models.map((model) => model.slug)).toEqual([
          "old-model",
          "other-model",
          "new-model",
        ]);
        yield* Deferred.succeed(releaseStartup, undefined);
        yield* Fiber.join(startup);

        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["unexpected-reprobe", "other-model"]),
        );
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
