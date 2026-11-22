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
import * as HostProcess from "@t3tools/shared/HostProcess";
import { toCustomModelSetting } from "@t3tools/shared/model";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as AcpRegistryAuthenticationState from "./authenticationState.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  AcpRegistryDriver,
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
    refreshIndex: () => Effect.succeed(0),
    currentIndexRevision: () => Effect.succeed(0),
    invalidateIndex: () => Effect.void,
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

    const entitled = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "gmodel", name: "GPT-Pro", description: null }],
        currentModelId: "gmodel",
        configOptions: [],
        modelsFromModelSelect: true,
      },
      [],
    );
    expect(entitled.models.map((m) => m.slug)).toEqual(["gmodel"]);
    expect(entitled.models.find((m) => m.slug === "gmodel")?.isDefault).toBe(true);

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
    const entry = {
      provider: providerWithModels([], null),
      expiresAt: 1_000,
      launchIdentity: "launch-a",
    };
    expect(isAcpRegistryCacheValid(entry, null, true, 999)).toBe(true);
    expect(isAcpRegistryCacheValid(entry, null, true, 1_000)).toBe(false);
    expect(isAcpRegistryCacheValid(entry, "2.0.0", false, 999)).toBe(false);
    expect(isAcpRegistryCacheValid(entry, "1.0.0", false, 999)).toBe(true);
    expect(isAcpRegistryCacheValid(entry, "1.0.0", false, 999, "launch-a")).toBe(true);
    expect(isAcpRegistryCacheValid(entry, "1.0.0", false, 999, "launch-b")).toBe(false);
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
    const cache = {
      invalidationGeneration: 1,
      liveGenerationByRuntime: new Map<string | null, number>(),
      entry: { provider, expiresAt: 1_000 },
    };

    const replayed = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 2_000,
    });

    expect(replayed).toBe(cache);
    expect(replayed.entry?.expiresAt).toBe(1_000);
  });

  it("updates the cache and promotes the expiry when live configuration discovers a catalog", () => {
    const provider = providerWithModels(
      [{ id: "smodel", name: "Default", description: null }],
      "smodel",
    );
    const cache = {
      invalidationGeneration: 1,
      liveGenerationByRuntime: new Map<string | null, number>(),
      entry: { provider, expiresAt: 1_000 },
    };

    const updated = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
    });

    expect(updated.entry?.provider.models.map((m) => m.slug)).toEqual(["auto", "qmodel", "kmodel"]);
    expect((updated.entry?.expiresAt ?? 0) - 5_000).toBe(15 * 60 * 1_000);
    expect(updated.invalidationGeneration).toBe(1);
    expect(updated.liveGenerationByRuntime.get(null)).toBe(1);
  });

  it("advances the cache epoch when a live update arrives before any probe lands", () => {
    const cache = {
      invalidationGeneration: 4,
      liveGenerationByRuntime: new Map<string | null, number>(),
      entry: null,
    };

    const updated = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
    });

    expect(updated.invalidationGeneration).toBe(4);
    expect(updated.liveGenerationByRuntime.get(null)).toBe(1);
    expect(updated.entry).toBeNull();
  });

  it("advances the incoming runtime's generation without replacing another runtime's cached entry", () => {
    const provider = providerWithModels(
      [{ id: "smodel", name: "Default", description: null }],
      "smodel",
    );
    const cache = {
      invalidationGeneration: 3,
      liveGenerationByRuntime: new Map<string | null, number>(),
      entry: { provider, expiresAt: 1_000, launchIdentity: "runtime-v1" },
    };

    const updated = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
      runtimeIdentity: "runtime-v2",
    });

    expect(updated.entry).toBe(cache.entry);
    expect(updated.invalidationGeneration).toBe(3);
    expect(updated.liveGenerationByRuntime.get("runtime-v2")).toBe(1);
    expect(updated.liveGenerationByRuntime.get("runtime-v1")).toBeUndefined();
    expect(updated.entry?.provider.models.map((m) => m.slug)).toEqual(["smodel"]);
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
    const modelIds = JSON.parse(readFileSync(process.argv[2], "utf8"));
    send({
      id,
      result: {
        sessionId: "probe-session",
        models: {
          currentModelId: modelIds[0],
          availableModels: modelIds.map((modelId) => ({ modelId, name: modelId })),
        },
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

const isWindowsHost = HostProcess.Platform.defaultValue() === "win32";
const testHostPlatform: NodeJS.Platform = isWindowsHost ? "win32" : "linux";
const compatibleRegistryTarget: AcpRegistrySupport.AcpRegistryPlatformTarget = isWindowsHost
  ? "windows-x86_64"
  : "linux-x86_64";
const incompatibleRegistryTarget: AcpRegistrySupport.AcpRegistryPlatformTarget = "darwin-aarch64";

const registryUrl = "https://registry.test/registry.json";

const makeBinaryRegistry = (
  version: string,
  target: AcpRegistrySupport.AcpRegistryPlatformTarget = compatibleRegistryTarget,
  options?: {
    readonly website?: string;
    readonly archiveSuffix?: string;
    readonly extraAgentVersion?: string;
  },
) =>
  JSON.stringify({
    version: "1.0.0",
    agents: [
      {
        id: "test-agent",
        name: "Test Agent",
        version,
        description: "Test binary agent",
        ...(options?.website ? { website: options.website } : {}),
        distribution: {
          binary: {
            [target]: {
              archive: `https://registry.test/test-agent-${version}${options?.archiveSuffix ?? ""}.bin`,
              cmd: "./bin/test-agent",
            },
          },
        },
      },
      ...(options?.extraAgentVersion
        ? [
            {
              id: "other-agent",
              name: "Other Agent",
              version: options.extraAgentVersion,
              description: "Unrelated agent",
              distribution: {
                binary: {
                  [target]: {
                    archive: `https://registry.test/other-agent-${options.extraAgentVersion}.bin`,
                    cmd: "./bin/other-agent",
                  },
                },
              },
            },
          ]
        : []),
    ],
  });

// A disk-cached 1.0.0 index with its binary installed, as left behind by an earlier session.
const seedInstalledBinaryAgent = Effect.fn("seedInstalledBinaryAgent")(function* (
  prefix: string,
  options?: { readonly website?: string },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  const agentPath = path.join(directory, "agent.mjs");
  const modelsPath = path.join(directory, "models.json");
  yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
  yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a", "model-b"]));
  yield* fileSystem.makeDirectory(path.join(directory, "acp-registry"), { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, "acp-registry", "registry.json"),
    makeBinaryRegistry("1.0.0", compatibleRegistryTarget, options),
  );
  const installedV1 = installedBinaryPath(path, directory, "1.0.0");
  yield* fileSystem.makeDirectory(path.dirname(installedV1), { recursive: true });
  yield* fileSystem.writeFileString(installedV1, "#!/bin/sh\necho 1.0.0\n");
  yield* fileSystem.writeFileString(
    path.join(path.dirname(path.dirname(installedV1)), ".t3-artifact.json"),
    JSON.stringify({
      archive: "https://registry.test/test-agent-1.0.0.bin",
      cmd: "./bin/test-agent",
      sha256: null,
    }),
  );
  if (!isWindowsHost) {
    yield* fileSystem.chmod(installedV1, 0o755);
  }
  return { directory, agentPath, modelsPath };
});

const installedBinaryPath = (path: Path.Path, directory: string, version: string) =>
  path.join(
    directory,
    "tools",
    "test-agent",
    version,
    compatibleRegistryTarget,
    "bin",
    "test-agent",
  );

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

  it.effect("refreshes a cached registry index on enrichment and explicit cache invalidation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, agentPath, modelsPath } =
        yield* seedInstalledBinaryAgent("acp-driver-update-");

      let latestVersion = "2.0.0";
      let registryRequests = 0;
      const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: directory,
        toolsDir: path.join(directory, "tools"),
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Platform, testHostPlatform),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            if (request.url === registryUrl) {
              registryRequests += 1;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(makeBinaryRegistry(latestVersion)),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(`#!/bin/sh\necho ${latestVersion}\n`),
              ),
            );
          }),
        ),
      );
      const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
        ...realCatalog,
        resolve: (settings, cwd, environment) =>
          realCatalog.resolve(settings, cwd, environment).pipe(
            Effect.map((resolved) => ({
              ...resolved,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            })),
          ),
      };

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

      const waitForEnriched = (version: string) =>
        instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === version && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
        );

      // Initial enrichment refreshes the disk-cached 1.0.0 index and installs 2.0.0.
      const upgradedToV2 = yield* waitForEnriched("2.0.0").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const first = Option.getOrThrow(yield* Fiber.join(upgradedToV2));
      expect(first.version).toBe("2.0.0");
      expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "2.0.0"))).toBe(true);

      // Explicit cache invalidation refreshes past the in-memory reuse window and installs 3.0.0.
      latestVersion = "3.0.0";
      const upgradedToV3 = yield* waitForEnriched("3.0.0").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      const second = Option.getOrThrow(yield* Fiber.join(upgradedToV3));
      expect(second.version).toBe("3.0.0");
      expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "3.0.0"))).toBe(true);

      // Disabled instances must not invalidate the shared registry freshness or fetch on refresh.
      const disabledRequestsBefore = registryRequests;
      latestVersion = "4.0.0";
      const disabled = yield* AcpRegistryDriver.create({
        instanceId: ProviderInstanceId.make("acpRegistry_disabled"),
        displayName: "Disabled ACP",
        enabled: false,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));
      yield* disabled.invalidateCaches ?? Effect.void;
      yield* disabled.snapshot.refresh;
      yield* catalog.refreshIndex({ maxAgeMs: 15 * 60 * 1_000, failureBackoffMs: 60_000 });
      expect(registryRequests).toBe(disabledRequestsBefore);
    }),
  );
});

describe("AcpRegistryDriver registry recovery", () => {
  it.effect(
    "recovers when a refreshed index moves from compatible to incompatible and back without cache invalidation",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const { directory, agentPath, modelsPath } =
          yield* seedInstalledBinaryAgent("acp-driver-recover-");

        let remoteVersion = "2.0.0";
        let remoteTarget: AcpRegistrySupport.AcpRegistryPlatformTarget = incompatibleRegistryTarget;
        let resolveAttempts = 0;
        let inspectCount = 0;
        let onRefreshDone: Effect.Effect<void> = Effect.void;
        const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: directory,
          toolsDir: path.join(directory, "tools"),
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, testHostPlatform),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    request.url === registryUrl
                      ? makeBinaryRegistry(remoteVersion, remoteTarget)
                      : `#!/bin/sh\necho ${remoteVersion}\n`,
                  ),
                ),
              ),
            ),
          ),
        );
        const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
          ...realCatalog,
          inspect: (settings, environment) =>
            Effect.sync(() => {
              inspectCount += 1;
            }).pipe(Effect.andThen(() => realCatalog.inspect(settings, environment))),
          refreshIndex: (options) =>
            realCatalog.refreshIndex(options).pipe(Effect.tap(() => onRefreshDone)),
          resolve: (settings, cwd, environment) =>
            Effect.sync(() => {
              resolveAttempts += 1;
            }).pipe(
              Effect.andThen(() => realCatalog.resolve(settings, cwd, environment)),
              Effect.map((resolved) => ({
                ...resolved,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              })),
            ),
        };

        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: identity.displayName,
          enabled: true,
          environment: [],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

        // 1. Compatible 1.0.0 transitions to incompatible 2.0.0.
        const becameUnsupported = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => !snapshot.installed && snapshot.version === "2.0.0"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const unsupported = Option.getOrThrow(yield* Fiber.join(becameUnsupported));
        expect(unsupported.status).toBe("error");

        // Same-revision refresh while uninstalled returns early without re-running inspect().
        const sameRevisionRefreshDone = yield* Deferred.make<void>();
        onRefreshDone = Deferred.succeed(sameRevisionRefreshDone, undefined).pipe(Effect.asVoid);
        const inspectsBeforeSameRevision = inspectCount;
        yield* instance.snapshot.refresh;
        yield* Deferred.await(sameRevisionRefreshDone);
        // A follow-up refresh synchronizes past the previous enrichment fiber's synchronous early return.
        const nextRefreshDone = yield* Deferred.make<void>();
        onRefreshDone = Deferred.succeed(nextRefreshDone, undefined).pipe(Effect.asVoid);
        yield* instance.snapshot.refresh;
        yield* Deferred.await(nextRefreshDone);
        onRefreshDone = Effect.void;
        // 2 refreshes × (checkProvider + auth.refreshMethods), with 0 enrichment rechecks.
        expect(inspectCount).toBe(inspectsBeforeSameRevision + 4);

        // 2. Live updates (config, commands, URL auth action) on the uninstalled snapshot cannot flip or leak into it;
        // a post-TTL refresh to another incompatible version publishes it without probing.
        const attemptsWhileUnsupported = resolveAttempts;
        remoteVersion = "2.1.0";
        const unsupportedSnapshots = yield* instance.snapshot.streamChanges.pipe(
          Stream.takeUntil((snapshot) => !snapshot.installed && snapshot.version === "2.1.0"),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "stale-model",
            availableModels: [
              { modelId: "stale-model", name: "stale-model" },
              { modelId: "stale-other", name: "stale-other" },
            ],
          }),
        );
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "stale-cmd" }],
          skills: [],
        });
        const authRequestWhileUnsupported = yield* coordinator
          .requestUrlAuthentication(identity.instanceId, {
            elicitationId: "uninstalled-auth",
            url: "https://example.test/uninstalled-auth",
            message: "Continue in your browser",
          })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("16 minutes");
        yield* instance.snapshot.refresh;
        const duringUnsupported = yield* Fiber.join(unsupportedSnapshots);
        expect(
          duringUnsupported.every(
            (snapshot) =>
              !snapshot.installed &&
              snapshot.status === "error" &&
              snapshot.slashCommands.length === 0 &&
              snapshot.auth.action === undefined,
          ),
        ).toBe(true);
        expect(resolveAttempts).toBe(attemptsWhileUnsupported);
        yield* Fiber.interrupt(authRequestWhileUnsupported);

        // 3. Upstream restores compatible 3.0.0; one post-TTL refresh clears the error and stale live state before probing and installs 3.0.0.
        remoteVersion = "3.0.0";
        remoteTarget = compatibleRegistryTarget;
        const recoverySnapshots = yield* instance.snapshot.streamChanges.pipe(
          Stream.takeUntil(
            (snapshot) =>
              snapshot.installed &&
              snapshot.version === "3.0.0" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* TestClock.adjust("16 minutes");
        yield* instance.snapshot.refresh;
        const snapshots = yield* Fiber.join(recoverySnapshots);
        const recheckedIndex = snapshots.findIndex(
          (snapshot) =>
            snapshot.installed &&
            snapshot.version === "3.0.0" &&
            snapshot.nativeSessions === undefined,
        );
        expect(recheckedIndex).toBeGreaterThanOrEqual(0);
        const ready = snapshots[snapshots.length - 1]!;
        expect(recheckedIndex).toBeLessThan(snapshots.length - 1);
        expect(ready.status).toBe("ready");
        expect(ready.version).toBe("3.0.0");
        expect(ready.nativeSessions).toBeDefined();
        expect(ready.models.map((model) => model.slug)).toEqual(["model-a", "model-b"]);
        expect(ready.slashCommands).toEqual([]);
        expect(resolveAttempts).toBeGreaterThan(attemptsWhileUnsupported);
        expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "3.0.0"))).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );

  it.effect(
    "publishes cold and cached probes immediately while backing off and reconciling failed upgrade fallbacks",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { directory, agentPath, modelsPath } = yield* seedInstalledBinaryAgent(
          "acp-driver-slow-refresh-",
        );
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;

        let remoteVersion = "2.0.0";
        let remoteWebsite: string | undefined = undefined;
        let remoteExtraAgentVersion: string | undefined = undefined;
        let failArchiveDownload = false;
        let inspectCalls = 0;
        let probeResolveAttempts = 0;
        let onFallbackResolved: (() => Effect.Effect<void>) | null = null;
        let onEnrichmentEnd: ((exit: Exit.Exit<unknown, unknown>) => void) | null = null;
        const testTracer: Tracer.Tracer = {
          span(options) {
            const inner = Tracer.nativeTracer.span(options);
            if (options.name !== "AcpRegistryDriver.publishEnrichment") return inner;
            const origEnd = inner.end.bind(inner);
            inner.end = (endTime, exit) => {
              origEnd(endTime, exit);
              onEnrichmentEnd?.(exit);
            };
            return inner;
          },
        };
        const initialGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        let gate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = initialGate;
        const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: directory,
          toolsDir: path.join(directory, "tools"),
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, testHostPlatform),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const respond = Effect.sync(() =>
                HttpClientResponse.fromWeb(
                  request,
                  request.url === registryUrl
                    ? new Response(
                        makeBinaryRegistry(remoteVersion, compatibleRegistryTarget, {
                          ...(remoteWebsite ? { website: remoteWebsite } : {}),
                          ...(remoteExtraAgentVersion
                            ? { extraAgentVersion: remoteExtraAgentVersion }
                            : {}),
                        }),
                      )
                    : failArchiveDownload
                      ? new Response("archive unavailable", { status: 503 })
                      : new Response(`#!/bin/sh\necho ${remoteVersion}\n`),
                ),
              );
              const activeGate = request.url === registryUrl ? gate : null;
              return activeGate === null
                ? respond
                : Deferred.succeed(activeGate.started, undefined).pipe(
                    Effect.andThen(Deferred.await(activeGate.release)),
                    Effect.andThen(respond),
                  );
            }),
          ),
        );
        const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
          ...realCatalog,
          inspect: (settings, environment) =>
            Effect.sync(() => {
              inspectCalls += 1;
            }).pipe(Effect.andThen(() => realCatalog.inspect(settings, environment))),
          resolve: (settings, cwd, environment) =>
            Effect.sync(() => {
              if (environment?.MISE_OFFLINE === "1") {
                probeResolveAttempts += 1;
              }
            }).pipe(
              Effect.andThen(() => realCatalog.resolve(settings, cwd, environment)),
              Effect.tap((resolved) =>
                resolved.fallback && onFallbackResolved !== null
                  ? onFallbackResolved()
                  : Effect.void,
              ),
              Effect.map((resolved) => ({
                ...resolved,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              })),
            ),
        };

        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: identity.displayName,
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(Tracer.Tracer, testTracer),
        );

        // On cold startup, the disk-cached 1.0.0 probe publishes before the slow 2.0.0 registry fetch finishes.
        const coldReady = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "1.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const upgradedToV2 = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "2.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(initialGate.started);
        expect(Option.isSome(yield* Fiber.join(coldReady))).toBe(true);

        yield* Deferred.succeed(initialGate.release, undefined);
        expect(Option.isSome(yield* Fiber.join(upgradedToV2))).toBe(true);

        // A live-session update at +10m extends enrichmentCache past +16m while the registry index expires.
        yield* TestClock.adjust("10 minutes");
        const liveUpdated = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((model) => model.slug === "model-c")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "model-a",
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-c", name: "model-c" },
            ],
          }),
        );
        expect(Option.isSome(yield* Fiber.join(liveUpdated))).toBe(true);

        // At +16m, the registry fetch blocks, yet the cached 2.0.0 probe publishes immediately before release.
        remoteVersion = "3.0.0";
        const secondGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        gate = secondGate;
        const cachedPublished = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "2.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const upgradedToV3 = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "3.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* TestClock.adjust("6 minutes");
        yield* instance.snapshot.refresh;
        yield* Deferred.await(secondGate.started);
        expect(Option.isSome(yield* Fiber.join(cachedPublished))).toBe(true);

        yield* Deferred.succeed(secondGate.release, undefined);
        expect(Option.isSome(yield* Fiber.join(upgradedToV3))).toBe(true);
        expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "3.0.0"))).toBe(true);

        // If 4.0.0 fails to download, the driver falls back to the installed 3.0.0 with a user-visible
        // status message, stays flicker-free during backoff, does not acknowledge the 4.0.0 revision,
        // and upgrades to 4.0.0 once backoff expires and the archive recovers.
        const v3LiveApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "v3-live-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "v3-live-cmd" }],
          skills: [],
        });
        expect(Option.isSome(yield* Fiber.join(v3LiveApplied))).toBe(true);

        gate = null;
        remoteVersion = "4.0.0";
        remoteWebsite = "https://example.test/v4";
        failArchiveDownload = true;
        const fallbackObserved = yield* Deferred.make<void>();
        onFallbackResolved = () =>
          Deferred.succeed(fallbackObserved, undefined).pipe(Effect.asVoid);
        const fallbackPublished = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "3.0.0" &&
              snapshot.status === "ready" &&
              snapshot.setup?.documentationUrl === "https://example.test/v4" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* TestClock.adjust("16 minutes");
        yield* instance.snapshot.refresh;
        yield* Deferred.await(fallbackObserved);
        const fallbackSnapshot = Option.getOrThrow(yield* Fiber.join(fallbackPublished));
        expect(fallbackSnapshot.message).toContain("4.0.0");
        expect(fallbackSnapshot.slashCommands).toEqual([{ name: "v3-live-cmd" }]);
        expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "4.0.0"))).toBe(false);
        onFallbackResolved = null;

        // Refreshing inside the 60s fallback backoff window must not flicker to 4.0.0, drop v3 live
        // commands, or re-run probe/download attempts.
        const resolvesBeforeBackoffRefresh = probeResolveAttempts;
        const backoffSnapshots: Array<ServerProvider> = [];
        const backoffCollector = yield* instance.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              backoffSnapshots.push(snapshot);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const backoffEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(backoffEnrichmentDone, Exit.void);
          }
        };
        yield* TestClock.adjust("30 seconds");
        yield* instance.snapshot.refresh.pipe(Effect.provideService(Tracer.Tracer, testTracer));
        yield* Deferred.await(backoffEnrichmentDone);
        onEnrichmentEnd = null;
        yield* Fiber.interrupt(backoffCollector);
        expect(probeResolveAttempts).toBe(resolvesBeforeBackoffRefresh);
        expect(backoffSnapshots.every((snapshot) => snapshot.version === "3.0.0")).toBe(true);
        expect(
          backoffSnapshots.every((snapshot) => snapshot.message === fallbackSnapshot.message),
        ).toBe(true);
        expect(
          backoffSnapshots.every((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "v3-live-cmd"),
          ),
        ).toBe(true);

        // Live configuration updates during fallback must also preserve the fallback warning message.
        const v3LiveConfigDuringFallback = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) =>
              model.capabilities?.optionDescriptors?.some((opt) => opt.id === "fallback-effort"),
            ),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([
            {
              id: "fallback-effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "High" }],
            },
          ]),
        );
        const liveFallbackSnapshot = Option.getOrThrow(
          yield* Fiber.join(v3LiveConfigDuringFallback),
        );
        expect(liveFallbackSnapshot.message).toBe(fallbackSnapshot.message);

        // Unrelated agent changes or non-launch metadata updates during fallback backoff must
        // refresh displayed metadata without re-probing or resetting backoff.
        remoteWebsite = "https://example.test/v4-updated-docs";
        remoteExtraAgentVersion = "9.9.9";
        yield* realCatalog.invalidateIndex();
        const resolvesBeforeMetadataBackoff = probeResolveAttempts;
        const metadataBackoffDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(metadataBackoffDone, Exit.void);
          }
        };
        yield* instance.snapshot.refresh.pipe(Effect.provideService(Tracer.Tracer, testTracer));
        yield* Deferred.await(metadataBackoffDone);
        onEnrichmentEnd = null;
        expect(probeResolveAttempts).toBe(resolvesBeforeMetadataBackoff);
        const metadataBackoffSnapshot = yield* instance.snapshot.getSnapshot;
        expect(metadataBackoffSnapshot.version).toBe("3.0.0");
        expect(metadataBackoffSnapshot.setup?.documentationUrl).toBe(
          "https://example.test/v4-updated-docs",
        );
        expect(metadataBackoffSnapshot.message).toBe(fallbackSnapshot.message);

        // A follow-up refresh at the same revision inside backoff skips enrichment recheck
        // completely because targetIndexRevision was updated to the new revision.
        const inspectsBeforeSameRevBackoff = inspectCalls;
        const sameRevBackoffDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(sameRevBackoffDone, Exit.void);
          }
        };
        yield* instance.snapshot.refresh.pipe(Effect.provideService(Tracer.Tracer, testTracer));
        yield* Deferred.await(sameRevBackoffDone);
        onEnrichmentEnd = null;
        expect(probeResolveAttempts).toBe(resolvesBeforeMetadataBackoff);
        // Only checkProvider + auth.refreshMethods run; 0 enrichment inspectReadiness rechecks.
        expect(inspectCalls).toBe(inspectsBeforeSameRevBackoff + 2);

        // Once backoff expires, recovering without invalidating the cached 4.0.0 index still upgrades
        // because fallback did not acknowledge the 4.0.0 revision.
        failArchiveDownload = false;
        const upgradedToV4 = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "4.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* TestClock.adjust("31 seconds");
        yield* instance.snapshot.refresh;
        const v4Snapshot = Option.getOrThrow(yield* Fiber.join(upgradedToV4));
        expect(v4Snapshot.message).toBeUndefined();
        expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "4.0.0"))).toBe(true);

        // A 1-model agent (30s provisional cache TTL) still respects the 60s fallback backoff at +31s,
        // and invalidateCaches clears activeFallback so the next refresh retries immediately.
        remoteVersion = "5.0.0";
        failArchiveDownload = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const singleModelInstanceId = ProviderInstanceId.make("acpRegistry_single_model_backoff");
        const singleModelFallbackDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(singleModelFallbackDone, Exit.void);
          }
        };
        const singleModelInstance = yield* AcpRegistryDriver.create({
          instanceId: singleModelInstanceId,
          displayName: "Single Model Backoff",
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(Tracer.Tracer, testTracer),
        );
        yield* Deferred.await(singleModelFallbackDone);
        onEnrichmentEnd = null;
        const soloFallbackSnapshot = yield* singleModelInstance.snapshot.getSnapshot;
        expect(soloFallbackSnapshot.version).toBe("4.0.0");
        expect(soloFallbackSnapshot.message).toContain("5.0.0");

        // Narrow the cached fallback entry to a single explicit model (30s provisional TTL).
        const soloModelApplied = yield* singleModelInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) => model.slug === "solo-v4-model"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          singleModelInstanceId,
          normalizeAcpRegistryLiveConfiguration([
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "solo-v4-model",
              options: [{ value: "solo-v4-model", name: "Solo V4" }],
            },
          ]),
        );
        const soloAppliedSnapshot = Option.getOrThrow(yield* Fiber.join(soloModelApplied));
        expect(soloAppliedSnapshot.models.map((model) => model.slug)).toEqual(["solo-v4-model"]);
        expect(soloAppliedSnapshot.message).toBe(soloFallbackSnapshot.message);

        const resolvesBeforeSolo31s = probeResolveAttempts;
        const solo31sDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(solo31sDone, Exit.void);
          }
        };
        yield* TestClock.adjust("31 seconds");
        yield* singleModelInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, testTracer),
        );
        yield* Deferred.await(solo31sDone);
        onEnrichmentEnd = null;
        expect(probeResolveAttempts).toBe(resolvesBeforeSolo31s);
        const soloAfter31s = yield* singleModelInstance.snapshot.getSnapshot;
        expect(soloAfter31s.message).toBe(soloFallbackSnapshot.message);
        expect(soloAfter31s.models.map((model) => model.slug)).toEqual(["solo-v4-model"]);

        // Calling invalidateCaches clears activeFallback and retries immediately even inside 60s.
        yield* singleModelInstance.invalidateCaches ?? Effect.void;
        const soloAfterInvalidateDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(soloAfterInvalidateDone, Exit.void);
          }
        };
        yield* singleModelInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, testTracer),
        );
        yield* Deferred.await(soloAfterInvalidateDone);
        onEnrichmentEnd = null;
        expect(probeResolveAttempts).toBe(resolvesBeforeSolo31s + 1);
        const v5Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v5Inspection.status).toBe("ready");
        const v5Identity = v5Inspection.status === "ready" ? v5Inspection.launchIdentity! : "";

        // When inspect() sees cached 5.0.0 while resolve() refreshes to failing 6.0.0 and falls back
        // to 4.0.0, activeFallback records 6.0.0 (from resolved.failedTarget) and external 6.0.0 live
        // state reconciles freshInstance to 6.0.0.
        remoteVersion = "6.0.0";
        yield* realCatalog.invalidateIndex();
        const resolvesBeforeFreshFallback = probeResolveAttempts;
        const freshFallbackDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(freshFallbackDone, Exit.void);
          }
        };
        const freshInstanceId = ProviderInstanceId.make("acpRegistry_fallback_single_probe");
        const freshInstance = yield* AcpRegistryDriver.create({
          instanceId: freshInstanceId,
          displayName: "Fallback Single Probe",
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(Tracer.Tracer, testTracer),
        );
        yield* Deferred.await(freshFallbackDone);
        onEnrichmentEnd = null;
        const freshFallbackSnapshot = yield* freshInstance.snapshot.getSnapshot;
        expect(freshFallbackSnapshot.version).toBe("4.0.0");
        expect(freshFallbackSnapshot.message).toContain("6.0.0");
        expect(probeResolveAttempts).toBe(resolvesBeforeFreshFallback + 1);

        // External 6.0.0 live state clears activeFallback and reconciles freshInstance to 6.0.0.
        failArchiveDownload = false;
        const v6Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v6Inspection.status).toBe("ready");
        const v6Identity = v6Inspection.status === "ready" ? v6Inspection.launchIdentity! : "";
        const freshReconciledToV6 = yield* freshInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "6.0.0" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((command) => command.name === "v6-external-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          freshInstanceId,
          { slashCommands: [{ name: "v6-external-cmd" }], skills: [] },
          v6Identity,
        );
        const reconciledV6Snapshot = Option.getOrThrow(yield* Fiber.join(freshReconciledToV6));
        expect(reconciledV6Snapshot.version).toBe("6.0.0");
        expect(reconciledV6Snapshot.message).toBeUndefined();

        // On cold-start fallback where inspect() already seeded activeRuntimeIdentity to the failing
        // target (5.0.0 on singleModelInstance), 5.0.0 was never successfully started and must not be
        // retired, so external 5.0.0 live state still reconciles singleModelInstance once 5.0.0 recovers.
        remoteVersion = "5.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const singleReconciledToV5 = yield* singleModelInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "5.0.0" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((command) => command.name === "v5-external-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          singleModelInstanceId,
          { slashCommands: [{ name: "v5-external-cmd" }], skills: [] },
          v5Identity,
        );
        const reconciledV5Snapshot = Option.getOrThrow(yield* Fiber.join(singleReconciledToV5));
        expect(reconciledV5Snapshot.version).toBe("5.0.0");
        expect(reconciledV5Snapshot.message).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );

  it.effect(
    "publishes same-version metadata updates without re-probing, re-probes same-version launch swaps, clears stale live state on upgrade, and retries skipped probes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseCoordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const { directory, agentPath, modelsPath } = yield* seedInstalledBinaryAgent(
          "acp-driver-meta-session-",
          { website: "https://example.test/v1" },
        );

        let remoteVersion = "1.0.0";
        let remoteWebsite: string | undefined = "https://example.test/v1";
        let remoteArchiveSuffix = "";
        let remoteExtraAgentVersion: string | undefined = undefined;
        let registryRequests = 0;
        let resolveAttempts = 0;
        let lastResolvedCommand = "";
        let backgroundProbeCalls = 0;
        let onInspectStart: (() => Effect.Effect<void>) | null = null;
        let onInspect:
          | ((inspection: AcpRegistrySupport.AcpRegistryInspection) => Effect.Effect<void>)
          | null = null;
        let onBackgroundProbeOutcome: ((skipped: boolean) => Effect.Effect<void>) | null = null;
        let onRefreshIndex: Effect.Effect<void> = Effect.void;
        let onPublishEnrichmentEnd: ((exit: Exit.Exit<unknown, unknown>) => void) | null = null;
        const makeEnrichmentTracer = (
          onEnd: () => ((exit: Exit.Exit<unknown, unknown>) => void) | null,
        ): Tracer.Tracer => ({
          span(options) {
            const inner = Tracer.nativeTracer.span(options);
            if (options.name !== "AcpRegistryDriver.publishEnrichment") return inner;
            const origEnd = inner.end.bind(inner);
            inner.end = (endTime, exit) => {
              origEnd(endTime, exit);
              onEnd()?.(exit);
            };
            return inner;
          },
        });
        const coordinator: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"] =
          {
            ...baseCoordinator,
            runBackgroundProbe: (agentId, effect) =>
              Effect.sync(() => {
                backgroundProbeCalls += 1;
              }).pipe(
                Effect.andThen(() => baseCoordinator.runBackgroundProbe(agentId, effect)),
                Effect.tap((outcome) =>
                  onBackgroundProbeOutcome === null
                    ? Effect.void
                    : onBackgroundProbeOutcome(Option.isNone(outcome)),
                ),
              ),
          };
        const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: directory,
          toolsDir: path.join(directory, "tools"),
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, testHostPlatform),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              if (request.url === registryUrl) {
                registryRequests += 1;
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      makeBinaryRegistry(remoteVersion, compatibleRegistryTarget, {
                        ...(remoteWebsite ? { website: remoteWebsite } : {}),
                        ...(remoteArchiveSuffix ? { archiveSuffix: remoteArchiveSuffix } : {}),
                        ...(remoteExtraAgentVersion
                          ? { extraAgentVersion: remoteExtraAgentVersion }
                          : {}),
                      }),
                    ),
                  ),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(`#!/bin/sh\necho ${remoteVersion}${remoteArchiveSuffix}\n`),
                ),
              );
            }),
          ),
        );
        const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
          ...realCatalog,
          inspect: (settings, environment) =>
            (onInspectStart === null ? Effect.void : onInspectStart()).pipe(
              Effect.andThen(() => realCatalog.inspect(settings, environment)),
              Effect.tap((inspection) =>
                onInspect === null ? Effect.void : onInspect(inspection),
              ),
            ),
          refreshIndex: (options) =>
            realCatalog.refreshIndex(options).pipe(Effect.tap(() => onRefreshIndex)),
          resolve: (settings, cwd, environment) =>
            Effect.sync(() => {
              resolveAttempts += 1;
            }).pipe(
              Effect.andThen(() => realCatalog.resolve(settings, cwd, environment)),
              Effect.tap((resolved) =>
                Effect.sync(() => {
                  lastResolvedCommand = resolved.spawn.command;
                }),
              ),
              Effect.map((resolved) => ({
                ...resolved,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              })),
            ),
        };

        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: identity.displayName,
          enabled: true,
          environment: [],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(
            Tracer.Tracer,
            makeEnrichmentTracer(() => onPublishEnrichmentEnd),
          ),
        );

        // Prime the 1.0.0 probe cache first so subsequent metadata-only refreshes can assert zero re-probes.
        const initialReady = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "1.0.0" &&
              snapshot.setup?.documentationUrl === "https://example.test/v1" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(Option.isSome(yield* Fiber.join(initialReady))).toBe(true);
        const resolvesAfterInitialProbe = resolveAttempts;

        // 1. Same-version metadata update publishes the new documentationUrl while preserving cached models, commands, and auth actions without re-probing.
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "status" }],
          skills: [],
        });
        const authActionReady = yield* Deferred.make<void>();
        const authWatcher = yield* coordinator
          .watchUrlAuthAction(identity.instanceId, (action) =>
            action === null
              ? Effect.void
              : Deferred.succeed(authActionReady, undefined).pipe(Effect.asVoid),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const authRequest = yield* coordinator
          .requestUrlAuthentication(identity.instanceId, {
            elicitationId: "auth-1",
            url: "https://example.test/auth",
            message: "Continue in your browser",
          })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(authActionReady);
        yield* Fiber.interrupt(authWatcher);
        remoteWebsite = "https://example.test/v1-updated";
        const updatedDocs = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "1.0.0" &&
              snapshot.setup?.documentationUrl === "https://example.test/v1-updated" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* catalog.invalidateIndex();
        yield* instance.snapshot.refresh;
        const withUpdatedDocs = Option.getOrThrow(yield* Fiber.join(updatedDocs));
        expect(withUpdatedDocs.models.map((model) => model.slug)).toEqual(["model-a", "model-b"]);
        expect(withUpdatedDocs.slashCommands).toEqual([{ name: "status" }]);
        expect(withUpdatedDocs.auth.action).toMatchObject({
          elicitationId: "auth-1",
          url: "https://example.test/auth",
        });
        expect(resolveAttempts).toBe(resolvesAfterInitialProbe);
        yield* Fiber.interrupt(authRequest);

        // Removing website clears setup.documentationUrl via the cached probe without re-probing.
        remoteWebsite = undefined;
        const clearedDocs = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "1.0.0" &&
              snapshot.setup?.documentationUrl === undefined &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* catalog.invalidateIndex();
        yield* instance.snapshot.refresh;
        const withClearedDocs = Option.getOrThrow(yield* Fiber.join(clearedDocs));
        expect(withClearedDocs.models.map((model) => model.slug)).toEqual(["model-a", "model-b"]);
        expect(resolveAttempts).toBe(resolvesAfterInitialProbe);

        // 2. An unrelated registry change plus a live command update does not schedule a second probe
        // and acknowledges the revision so a follow-up refresh skips rechecking.
        remoteExtraAgentVersion = "9.9.9";
        let unrelatedRefreshed = false;
        const unrelatedEnrichmentDone = yield* Deferred.make<void>();
        onRefreshIndex = Effect.sync(() => {
          unrelatedRefreshed = true;
        });
        onPublishEnrichmentEnd = (exit) => {
          if (unrelatedRefreshed && Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(unrelatedEnrichmentDone, Exit.void);
          }
        };
        const liveCommandApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "live-updated"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const probesBeforeUnrelated = backgroundProbeCalls;
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "live-updated" }],
          skills: [],
        });
        yield* catalog.invalidateIndex();
        yield* instance.snapshot.refresh.pipe(
          Effect.provideService(
            Tracer.Tracer,
            makeEnrichmentTracer(() => onPublishEnrichmentEnd),
          ),
        );
        // Wait for publishEnrichment itself to finish its post-refresh decision before asserting counts.
        yield* Deferred.await(unrelatedEnrichmentDone);
        expect(Option.isSome(yield* Fiber.join(liveCommandApplied))).toBe(true);
        onRefreshIndex = Effect.void;
        onPublishEnrichmentEnd = null;
        // 1 auth.refreshMethods + 1 initialProbe; 0 post-recheck probe calls.
        expect(backgroundProbeCalls).toBe(probesBeforeUnrelated + 2);
        expect(resolveAttempts).toBe(resolvesAfterInitialProbe);
        expect((yield* instance.snapshot.getSnapshot).slashCommands).toEqual([
          { name: "live-updated" },
        ]);

        // A freshly created instance on an already-refreshed catalog does not recheck the same revision.
        const secondInstanceId = ProviderInstanceId.make("acpRegistry_second_fresh");
        let secondInstanceRefreshed = false;
        let secondInstancePostRefreshInspects = 0;
        const secondEnrichmentDone = yield* Deferred.make<void>();
        onRefreshIndex = Effect.sync(() => {
          secondInstanceRefreshed = true;
        });
        onInspectStart = () =>
          secondInstanceRefreshed
            ? Effect.sync(() => {
                secondInstancePostRefreshInspects += 1;
              })
            : Effect.void;
        let onSecondEnrichmentEnd: ((exit: Exit.Exit<unknown, unknown>) => void) | null = (
          exit,
        ) => {
          if (secondInstanceRefreshed && Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(secondEnrichmentDone, Exit.void);
          }
        };
        yield* AcpRegistryDriver.create({
          instanceId: secondInstanceId,
          displayName: "Second ACP",
          enabled: true,
          environment: [],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(
            Tracer.Tracer,
            makeEnrichmentTracer(() => onSecondEnrichmentEnd),
          ),
        );
        // Wait for secondInstance's publishEnrichment span to complete past the revision skip decision.
        yield* Deferred.await(secondEnrichmentDone);
        onSecondEnrichmentEnd = null;
        onRefreshIndex = Effect.void;
        onInspectStart = null;
        expect(secondInstancePostRefreshInspects).toBe(0);

        // 3. Same-version launch distribution swap installs into an immutable artifact slot without
        // mutating the existing binary, invalidates the probe cache, and re-probes.
        remoteArchiveSuffix = "-repackaged";
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["model-swapped-a", "model-swapped-b"]),
        );
        const swappedReady = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "1.0.0" &&
              snapshot.models.some((model) => model.slug === "model-swapped-a"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const resolvesBeforeSwap = resolveAttempts;
        yield* catalog.invalidateIndex();
        yield* instance.snapshot.refresh;
        const swapped = Option.getOrThrow(yield* Fiber.join(swappedReady));
        expect(swapped.models.map((model) => model.slug)).toEqual([
          "model-swapped-a",
          "model-swapped-b",
        ]);
        expect(lastResolvedCommand).toMatch(
          new RegExp(`${compatibleRegistryTarget}-[0-9a-f]{12}[\\\\/]bin[\\\\/]test-agent$`),
        );
        expect(yield* fileSystem.readFileString(lastResolvedCommand)).toBe(
          "#!/bin/sh\necho 1.0.0-repackaged\n",
        );
        expect(
          yield* fileSystem.readFileString(installedBinaryPath(path, directory, "1.0.0")),
        ).toBe("#!/bin/sh\necho 1.0.0\n");
        const resolvesAfterSwap = resolveAttempts;
        expect(resolvesAfterSwap).toBeGreaterThan(resolvesBeforeSwap);

        // 4. Retained v1 live configuration/commands do not leak onto v2 readiness or probe snapshots,
        // and a probe skipped during a foreground session stays pending until the session ends.
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "v1-stale-a",
            availableModels: [
              { modelId: "v1-stale-a", name: "v1-stale-a" },
              { modelId: "v1-stale-b", name: "v1-stale-b" },
            ],
          }),
        );
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "v1-stale-cmd" }],
          skills: [],
        });
        remoteVersion = "2.0.0";
        remoteWebsite = "https://example.test/v2";
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["v2-model-a", "v2-model-b"]));
        const sessionStarted = yield* Deferred.make<void>();
        const releaseSession = yield* Deferred.make<void>();
        const sessionFiber = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(sessionStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSession)),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(sessionStarted);

        let sawV2InFirstRefresh = false;
        const firstV2ProbeSkipped = yield* Deferred.make<void>();
        onInspect = (inspection) =>
          inspection.status === "ready" && inspection.version === "2.0.0"
            ? Effect.sync(() => {
                sawV2InFirstRefresh = true;
              })
            : Effect.void;
        onBackgroundProbeOutcome = (skipped) =>
          skipped && sawV2InFirstRefresh
            ? Deferred.succeed(firstV2ProbeSkipped, undefined).pipe(Effect.asVoid)
            : Effect.void;
        yield* TestClock.adjust("16 minutes");
        yield* instance.snapshot.refresh;
        yield* Deferred.await(firstV2ProbeSkipped);

        // Collect every snapshot from Refresh #2 through v2 recovery to verify no v2 snapshot ever carries v1 live state.
        const v2TransitionSnapshots = yield* instance.snapshot.streamChanges.pipe(
          Stream.takeUntil(
            (snapshot) =>
              snapshot.version === "2.0.0" &&
              snapshot.setup?.documentationUrl === "https://example.test/v2" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );

        // A second refresh while the session is still active skips both probes (auth + enrichment) AND rechecks v2 after refreshIndex.
        let secondRefreshSkips = 0;
        let secondRefreshIndexChecked = false;
        const secondRefreshAllSkips = yield* Deferred.make<void>();
        const secondRefreshRechecked = yield* Deferred.make<void>();
        onBackgroundProbeOutcome = (skipped) =>
          skipped
            ? Effect.sync(() => {
                secondRefreshSkips += 1;
                return secondRefreshSkips;
              }).pipe(
                Effect.flatMap((count) =>
                  count >= 2
                    ? Deferred.succeed(secondRefreshAllSkips, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              )
            : Effect.void;
        onRefreshIndex = Effect.sync(() => {
          secondRefreshIndexChecked = true;
        });
        onInspect = (inspection) =>
          secondRefreshIndexChecked &&
          inspection.status === "ready" &&
          inspection.version === "2.0.0"
            ? Deferred.succeed(secondRefreshRechecked, undefined).pipe(Effect.asVoid)
            : Effect.void;
        yield* instance.snapshot.refresh;
        yield* Deferred.await(secondRefreshAllSkips);
        yield* Deferred.await(secondRefreshRechecked);
        expect(resolveAttempts).toBe(resolvesAfterSwap);
        expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "2.0.0"))).toBe(false);

        // Once the session ends, the next refresh installs v2 without another registry fetch and discards v1's stale live state.
        onInspect = null;
        onRefreshIndex = Effect.void;
        onBackgroundProbeOutcome = null;
        yield* Deferred.succeed(releaseSession, undefined);
        yield* Fiber.join(sessionFiber);
        const requestsBeforeRecovery = registryRequests;
        yield* instance.snapshot.refresh;
        const transitionSnapshots = yield* Fiber.join(v2TransitionSnapshots);
        const v2Snapshots = transitionSnapshots.filter((snapshot) => snapshot.version === "2.0.0");
        expect(v2Snapshots.length).toBeGreaterThanOrEqual(2);
        expect(
          v2Snapshots.every(
            (snapshot) =>
              !snapshot.slashCommands.some((command) => command.name === "v1-stale-cmd") &&
              !snapshot.models.some((model) => model.slug === "v1-stale-a"),
          ),
        ).toBe(true);
        const recovered = v2Snapshots[v2Snapshots.length - 1]!;
        expect(recovered.version).toBe("2.0.0");
        expect(recovered.models.map((model) => model.slug)).toEqual(["v2-model-a", "v2-model-b"]);
        expect(recovered.slashCommands).toEqual([]);
        expect(registryRequests).toBe(requestsBeforeRecovery);
        expect(yield* fileSystem.exists(installedBinaryPath(path, directory, "2.0.0"))).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );

  it.effect("labels and caches probes using the runtime selected by catalog.resolve", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, agentPath, modelsPath } = yield* seedInstalledBinaryAgent(
        "acp-driver-resolved-identity-",
        { website: "https://example.test/v1" },
      );

      let remoteVersion = "2.0.0";
      let remoteWebsite = "https://example.test/v2";
      let switchedBeforeResolve = false;
      let probeResolveAttempts = 0;
      const inspectedVersionsBeforeSwitch: Array<string | null> = [];
      const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: directory,
        toolsDir: path.join(directory, "tools"),
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Platform, testHostPlatform),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  request.url === registryUrl
                    ? makeBinaryRegistry(remoteVersion, compatibleRegistryTarget, {
                        website: remoteWebsite,
                      })
                    : `#!/bin/sh\necho ${remoteVersion}\n`,
                ),
              ),
            ),
          ),
        ),
      );
      const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
        ...realCatalog,
        inspect: (settings, environment) =>
          realCatalog.inspect(settings, environment).pipe(
            Effect.tap((inspection) =>
              !switchedBeforeResolve && inspection.status === "ready"
                ? Effect.sync(() => {
                    inspectedVersionsBeforeSwitch.push(inspection.version);
                  })
                : Effect.void,
            ),
          ),
        resolve: (settings, cwd, environment) =>
          Effect.gen(function* () {
            const isProbeResolve = environment?.MISE_OFFLINE === "1";
            if (isProbeResolve) {
              probeResolveAttempts += 1;
              // Simulate a concurrent registry refresh advancing the index to 2.0.0 after inspect() saw 1.0.0.
              if (!switchedBeforeResolve) {
                switchedBeforeResolve = true;
                yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
              }
            }
            const resolved = yield* realCatalog.resolve(settings, cwd, environment);
            return {
              ...resolved,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            };
          }),
      };

      yield* fileSystem.writeFileString(
        modelsPath,
        JSON.stringify(["v2-resolved-a", "v2-resolved-b"]),
      );
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

      // Let the initial startup check run once without triggering a concurrent refresh.
      const firstProbed = Option.getOrThrow(
        yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.nativeSessions !== undefined),
          Stream.runHead,
        ),
      );
      // Even though inspect() saw 1.0.0, the published probe carries 2.0.0's resolved version and metadata.
      expect(inspectedVersionsBeforeSwitch.length).toBeGreaterThan(0);
      expect(inspectedVersionsBeforeSwitch.every((version) => version === "1.0.0")).toBe(true);
      expect(firstProbed.version).toBe("2.0.0");
      expect(firstProbed.setup?.documentationUrl).toBe("https://example.test/v2");
      expect(firstProbed.models.map((model) => model.slug)).toEqual([
        "v2-resolved-a",
        "v2-resolved-b",
      ]);
      expect(probeResolveAttempts).toBe(1);

      // Refreshing on 2.0.0 reuses the cached probe keyed by 2.0.0's resolved launch identity.
      const cachedV2 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) => snapshot.version === "2.0.0" && snapshot.nativeSessions !== undefined,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      expect(Option.isSome(yield* Fiber.join(cachedV2))).toBe(true);
      expect(probeResolveAttempts).toBe(1);

      // Reverting upstream to 1.0.0 must miss the cache (proving v2's probe was not cached under 1.0.0's identity).
      remoteVersion = "1.0.0";
      remoteWebsite = "https://example.test/v1";
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["v1-fresh-a", "v1-fresh-b"]));
      yield* realCatalog.invalidateIndex();
      yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
      const revertedV1 = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.version === "1.0.0" &&
            snapshot.models.some((model) => model.slug === "v1-fresh-a"),
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const secondProbed = Option.getOrThrow(yield* Fiber.join(revertedV1));
      expect(secondProbed.models.map((model) => model.slug)).toEqual(["v1-fresh-a", "v1-fresh-b"]);
      expect(probeResolveAttempts).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );

  it.effect(
    "retires cached probes and live state when base checkProvider observes an uninstalled transition",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const { directory, agentPath, modelsPath } = yield* seedInstalledBinaryAgent(
          "acp-driver-base-uninstall-",
        );

        let remoteVersion = "1.0.0";
        let remoteTarget: AcpRegistrySupport.AcpRegistryPlatformTarget = compatibleRegistryTarget;
        const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: directory,
          toolsDir: path.join(directory, "tools"),
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, testHostPlatform),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    request.url === registryUrl
                      ? makeBinaryRegistry(remoteVersion, remoteTarget)
                      : `#!/bin/sh\necho ${remoteVersion}\n`,
                  ),
                ),
              ),
            ),
          ),
        );
        const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
          ...realCatalog,
          resolve: (settings, cwd, environment) =>
            realCatalog.resolve(settings, cwd, environment).pipe(
              Effect.map((resolved) => ({
                ...resolved,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              })),
            ),
        };

        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: identity.displayName,
          enabled: true,
          environment: [],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

        // Prime 1.0.0 cache and live state.
        const initialReady = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "1.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(Option.isSome(yield* Fiber.join(initialReady))).toBe(true);
        yield* coordinator.publishAvailableCommands(identity.instanceId, {
          slashCommands: [{ name: "stale-before-uninstall" }],
          skills: [],
        });

        // Another caller refreshes the shared catalog to incompatible 2.0.0 so checkProvider directly sees !installed.
        remoteVersion = "2.0.0";
        remoteTarget = incompatibleRegistryTarget;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const uninstalledSeen = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => !snapshot.installed && snapshot.version === "2.0.0"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(Option.isSome(yield* Fiber.join(uninstalledSeen))).toBe(true);

        // Restoring 1.0.0 before the 15-minute probe TTL must re-probe fresh models and not restore stale commands.
        remoteVersion = "1.0.0";
        remoteTarget = compatibleRegistryTarget;
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["recovered-fresh-a", "recovered-fresh-b"]),
        );
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const recovered = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.installed &&
              snapshot.version === "1.0.0" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const freshSnapshot = Option.getOrThrow(yield* Fiber.join(recovered));
        expect(freshSnapshot.models.map((model) => model.slug)).toEqual([
          "recovered-fresh-a",
          "recovered-fresh-b",
        ]);
        expect(freshSnapshot.slashCommands).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );

  it.effect(
    "preserves new-runtime live state across upgrades while rejecting older or queued stale watcher updates",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseCoordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const { directory, agentPath, modelsPath } = yield* seedInstalledBinaryAgent(
          "acp-driver-runtime-tagged-live-",
        );

        let remoteVersion = "1.0.0";
        let failProbeSpawn = false;
        let failProbeSpawnOnce = false;
        let inspectCalls = 0;
        let resolveGate: {
          readonly matchVersion: string;
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        let onInspectCallback: (() => Effect.Effect<void>) | null = null;
        let onCommandHandled: {
          readonly matchName: string;
          readonly done: Deferred.Deferred<void>;
        } | null = null;
        let queuedStaleConfigGate: {
          readonly entered: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
          readonly matchSlug: string;
        } | null = null;
        const coordinator: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"] =
          {
            ...baseCoordinator,
            watchAvailableCommands: (instanceId, onUpdate) =>
              baseCoordinator.watchAvailableCommands(instanceId, (commands, meta) =>
                onUpdate(commands, meta).pipe(
                  Effect.tap(() => {
                    if (
                      onCommandHandled !== null &&
                      commands.slashCommands.some((cmd) => cmd.name === onCommandHandled!.matchName)
                    ) {
                      const handled = onCommandHandled;
                      onCommandHandled = null;
                      return Deferred.succeed(handled.done, undefined).pipe(Effect.asVoid);
                    }
                    return Effect.void;
                  }),
                ),
              ),
            watchLiveConfiguration: (instanceId, onUpdate) =>
              baseCoordinator.watchLiveConfiguration(instanceId, (configuration, meta) => {
                const activeGate =
                  queuedStaleConfigGate !== null &&
                  configuration.models.some(
                    (model) => model.id === queuedStaleConfigGate!.matchSlug,
                  )
                    ? queuedStaleConfigGate
                    : null;
                if (activeGate === null) return onUpdate(configuration, meta);
                queuedStaleConfigGate = null;
                return Deferred.succeed(activeGate.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(activeGate.release)),
                  Effect.andThen(onUpdate(configuration, meta)),
                );
              }),
          };
        const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: directory,
          toolsDir: path.join(directory, "tools"),
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, testHostPlatform),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    request.url === registryUrl
                      ? makeBinaryRegistry(remoteVersion)
                      : `#!/bin/sh\necho ${remoteVersion}\n`,
                  ),
                ),
              ),
            ),
          ),
        );
        const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
          ...realCatalog,
          inspect: (settings, environment) =>
            Effect.sync(() => {
              inspectCalls += 1;
            }).pipe(
              Effect.andThen(() => realCatalog.inspect(settings, environment)),
              Effect.tap(() => (onInspectCallback === null ? Effect.void : onInspectCallback())),
            ),
          resolve: (settings, cwd, environment) =>
            Effect.gen(function* () {
              const resolved = yield* realCatalog.resolve(settings, cwd, environment);
              if (
                environment?.MISE_OFFLINE === "1" &&
                resolveGate !== null &&
                resolved.agent?.version === resolveGate.matchVersion
              ) {
                const gate = resolveGate;
                resolveGate = null;
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.release);
              }
              if (environment?.MISE_OFFLINE === "1" && (failProbeSpawn || failProbeSpawnOnce)) {
                failProbeSpawnOnce = false;
                return yield* new AcpRegistrySupport.AcpRegistryError({
                  reason: "install_failed",
                  detail: `Simulated probe install failure for ${resolved.agent?.version ?? "unknown"}.`,
                });
              }
              return {
                ...resolved,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              };
            }),
        };

        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: identity.displayName,
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
        );

        // Prime 1.0.0 and capture its launch identity.
        const initialReady = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "1.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        expect(Option.isSome(yield* Fiber.join(initialReady))).toBe(true);
        const v1Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v1Inspection.status).toBe("ready");
        const v1Identity = v1Inspection.status === "ready" ? v1Inspection.launchIdentity! : "";

        // 0. Same-runtime live config update arriving while a v1 probe is in flight discards the
        // older v1 probe so stale probe models cannot overwrite newer live configuration.
        // Publish an option-only update (models: []) so without the generation guard the stale
        // probe's ["v1-stale-probe-a", "v1-stale-probe-b"] catalog would overwrite ["model-a", "model-b"].
        let onEnrichmentSpanEnd: ((exit: Exit.Exit<unknown, unknown>) => void) | null = null;
        const enrichmentTracer: Tracer.Tracer = {
          span(options) {
            const inner = Tracer.nativeTracer.span(options);
            if (options.name !== "AcpRegistryDriver.publishEnrichment") return inner;
            const origEnd = inner.end.bind(inner);
            inner.end = (endTime, exit) => {
              origEnd(endTime, exit);
              onEnrichmentSpanEnd?.(exit);
            };
            return inner;
          },
        };
        yield* instance.invalidateCaches ?? Effect.void;
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["v1-stale-probe-a", "v1-stale-probe-b"]),
        );
        const v1ProbeGate = {
          matchVersion: "1.0.0",
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        resolveGate = v1ProbeGate;
        const v1ProbeSnapshots: Array<ServerProvider> = [];
        const v1ProbeCollector = yield* instance.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              v1ProbeSnapshots.push(snapshot);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const v1StaleEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentSpanEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(v1StaleEnrichmentDone, Exit.void);
          }
        };
        yield* instance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(v1ProbeGate.started);
        const v1NewerLiveApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) =>
              model.capabilities?.optionDescriptors?.some((opt) => opt.id === "v1-live-effort"),
            ),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([
            {
              id: "v1-live-effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "High" }],
            },
          ]),
          v1Identity,
        );
        expect(Option.isSome(yield* Fiber.join(v1NewerLiveApplied))).toBe(true);
        yield* Deferred.succeed(v1ProbeGate.release, undefined);
        yield* Deferred.await(v1StaleEnrichmentDone);
        onEnrichmentSpanEnd = null;
        yield* Fiber.interrupt(v1ProbeCollector);
        const v1AfterSuperseded = yield* instance.snapshot.getSnapshot;
        // Without isProbeStillCurrent, the released probe would overwrite ["default"] with
        // ["v1-stale-probe-a", "v1-stale-probe-b"] because the live update sent models: [].
        expect(v1AfterSuperseded.models.map((model) => model.slug)).toEqual(["default"]);
        expect(
          v1AfterSuperseded.models.some((model) =>
            model.capabilities?.optionDescriptors?.some((opt) => opt.id === "v1-live-effort"),
          ),
        ).toBe(true);
        expect(
          v1ProbeSnapshots.every(
            (snapshot) => !snapshot.models.some((model) => model.slug === "v1-stale-probe-a"),
          ),
        ).toBe(true);

        // Start a refresh that upgrades 1.0.0 -> 2.0.0 mid-enrichment while the live watcher stays active.
        remoteVersion = "2.0.0";
        yield* fileSystem.writeFileString(
          modelsPath,
          JSON.stringify(["v2-probed-a", "v2-probed-b"]),
        );
        yield* realCatalog.invalidateIndex();
        const v2ProbeGate = {
          matchVersion: "2.0.0",
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        resolveGate = v2ProbeGate;
        const v2ProbedReady = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "2.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(v2ProbeGate.started);
        const v2Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v2Inspection.status).toBe("ready");
        const v2Identity = v2Inspection.status === "ready" ? v2Inspection.launchIdentity! : "";
        expect(v2Identity).not.toBe(v1Identity);

        // 1. A live config update from displayed runtime v1 (which also learns an effort option on shared-model)
        // updates v1's displayed snapshot without discarding the in-flight v2 upgrade probe.
        const v1LiveUpdated = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "1.0.0" &&
              snapshot.models.some((model) => model.slug === "v1-during-probe-a"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
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
              currentModelId: "shared-model",
              availableModels: [
                { modelId: "v1-during-probe-a", name: "v1-during-probe-a" },
                { modelId: "shared-model", name: "shared-model" },
              ],
            },
          ),
          v1Identity,
        );
        expect(Option.isSome(yield* Fiber.join(v1LiveUpdated))).toBe(true);

        // 2. Queue an UNTAGGED stale update on this active enrichment fiber before v2 commits
        // so rejecting it later proves the clear watermark (!isCurrent) independently of runtimeIdentity.
        const staleGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          matchSlug: "v1-queued-a",
        };
        queuedStaleConfigGate = staleGate;
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "v1-queued-a",
            availableModels: [
              { modelId: "v1-queued-a", name: "v1-queued-a" },
              { modelId: "v1-queued-b", name: "v1-queued-b" },
            ],
          }),
        );
        yield* Deferred.await(staleGate.entered);

        // 3. Publish v2 live state while the v2 probe is already in flight; inFlightProbeIdentity must
        // skip spawning a redundant reconcile inspect, and v2 must preserve its live state without
        // inheriting v1 learnedModels.
        const inspectsBeforeInFlightV2 = inspectCalls;
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v2-live-cmd" }], skills: [] },
          v2Identity,
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "v2-live-a",
            availableModels: [
              { modelId: "v2-live-a", name: "v2-live-a" },
              { modelId: "shared-model", name: "shared-model" },
            ],
          }),
          v2Identity,
        );
        yield* Deferred.succeed(v2ProbeGate.release, undefined);

        const publishedV2 = Option.getOrThrow(yield* Fiber.join(v2ProbedReady));
        expect(inspectCalls).toBe(inspectsBeforeInFlightV2);
        expect(publishedV2.models.map((model) => model.slug)).toEqual([
          "v2-live-a",
          "shared-model",
        ]);
        expect(
          publishedV2.models.find((model) => model.slug === "shared-model")?.capabilities
            ?.optionDescriptors ?? [],
        ).toEqual([]);
        expect(publishedV2.slashCommands).toEqual([{ name: "v2-live-cmd" }]);

        // Synchronize past runProbeAndPublish releasing liveSnapshotSemaphore (so clearLiveState has completed).
        const v2PostClear = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "v2-post-clear"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v2-post-clear" }], skills: [] },
          v2Identity,
        );
        expect(Option.isSome(yield* Fiber.join(v2PostClear))).toBe(true);

        // 4. Release the queued untagged update (rejected solely by !isCurrent), then publish post-clear v1-tagged
        // updates (whose revision is AFTER clear, so rejected solely by runtimeIdentity) without evicting v2 state
        // and without triggering reconcile catalog.inspect disk I/O for retired v1.
        const inspectsBeforeRetiredV1 = inspectCalls;
        const liveRaceSnapshots = yield* instance.snapshot.streamChanges.pipe(
          Stream.takeUntil(
            (snapshot) =>
              snapshot.models.some((model) => model.slug === "v2-final-a") &&
              snapshot.slashCommands.some((command) => command.name === "v2-after-race"),
          ),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.succeed(staleGate.release, undefined);
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "v1-late-a",
            availableModels: [
              { modelId: "v1-late-a", name: "v1-late-a" },
              { modelId: "v1-late-b", name: "v1-late-b" },
            ],
          }),
          v1Identity,
        );
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v1-late-cmd" }], skills: [] },
          v1Identity,
        );
        // Late v1 publications must not evict v2's stored coordinator entry.
        expect(
          yield* coordinator.getAvailableCommands(identity.instanceId, {
            runtimeIdentity: v2Identity,
            requireMatchingRuntimeIdentity: true,
          }),
        ).toEqual(Option.some({ slashCommands: [{ name: "v2-post-clear" }], skills: [] }));

        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "v2-final-a",
            availableModels: [
              { modelId: "v2-final-a", name: "v2-final-a" },
              { modelId: "v2-final-b", name: "v2-final-b" },
            ],
          }),
          v2Identity,
        );
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v2-after-race" }], skills: [] },
          v2Identity,
        );
        const observedAfterRace = yield* Fiber.join(liveRaceSnapshots);
        // Trigger a subsequent unmatched identity inspect on driverScope to drain any concurrently
        // forked fibers from retired v1 updates: exactly 1 inspect (for the sentinel) must run.
        const retiredDrainDone = yield* Deferred.make<void>();
        onInspectCallback = () => Deferred.succeed(retiredDrainDone, undefined).pipe(Effect.asVoid);
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "sentinel-after-retired" }], skills: [] },
          "retired-drain-sentinel",
        );
        yield* Deferred.await(retiredDrainDone);
        onInspectCallback = null;
        expect(inspectCalls).toBe(inspectsBeforeRetiredV1 + 1);
        expect(
          observedAfterRace.every(
            (snapshot) =>
              !snapshot.models.some(
                (model) => model.slug === "v1-queued-a" || model.slug === "v1-late-a",
              ) && !snapshot.slashCommands.some((command) => command.name === "v1-late-cmd"),
          ),
        ).toBe(true);
        const afterRace = observedAfterRace[observedAfterRace.length - 1]!;
        expect(afterRace.models.map((model) => model.slug)).toEqual(["v2-final-a", "v2-final-b"]);
        expect(afterRace.slashCommands).toEqual([{ name: "v2-after-race" }]);

        // 5. When the shared catalog advances to 3.0.0 and a 3.0.0 session publishes live commands before this
        // instance refreshes, the driver automatically reconciles to 3.0.0 instead of dropping the update.
        remoteVersion = "3.0.0";
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["v3-model-a", "v3-model-b"]));
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const v3Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v3Inspection.status).toBe("ready");
        const v3Identity = v3Inspection.status === "ready" ? v3Inspection.launchIdentity! : "";
        const reconciledV3 = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "3.0.0" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((command) => command.name === "v3-session-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const v3EnrichmentSettled = yield* Deferred.make<void>();
        let sawV3Enrichment = false;
        const v3Tracer: Tracer.Tracer = {
          span(options) {
            const inner = Tracer.nativeTracer.span(options);
            if (options.name !== "AcpRegistryDriver.publishEnrichment") return inner;
            const origEnd = inner.end.bind(inner);
            inner.end = (endTime, exit) => {
              origEnd(endTime, exit);
              if (sawV3Enrichment && Exit.isSuccess(exit)) {
                Deferred.doneUnsafe(v3EnrichmentSettled, Exit.void);
              }
            };
            return inner;
          },
        };
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v3-session-cmd" }], skills: [] },
          v3Identity,
        );
        const v3Snapshot = Option.getOrThrow(yield* Fiber.join(reconciledV3));
        expect(v3Snapshot.version).toBe("3.0.0");
        expect(v3Snapshot.slashCommands).toEqual([{ name: "v3-session-cmd" }]);
        // Settle the 3.0.0 enrichment cycle before counting inspects for the unmatched-runtime check.
        sawV3Enrichment = true;
        yield* instance.snapshot.refresh.pipe(Effect.provideService(Tracer.Tracer, v3Tracer));
        yield* Deferred.await(v3EnrichmentSettled);

        // An unrecognized runtime identity that does NOT match catalog.inspect must not trigger a refresh.
        const unmatchedChecked = yield* Deferred.make<void>();
        onInspectCallback = () => Deferred.succeed(unmatchedChecked, undefined).pipe(Effect.asVoid);
        const inspectsBeforeUnmatched = inspectCalls;
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "bogus-future-cmd" }], skills: [] },
          "unmatched-future-runtime",
        );
        yield* Deferred.await(unmatchedChecked);
        onInspectCallback = null;
        const v3Check = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "v3-still-active"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v3-still-active" }], skills: [] },
          v3Identity,
        );
        expect(Option.isSome(yield* Fiber.join(v3Check))).toBe(true);
        // Only the 1 reconcile inspect ran; no refresh (which would invoke another inspect) fired.
        expect(inspectCalls).toBe(inspectsBeforeUnmatched + 1);

        // 6. A failed upgrade probe (4.0.0 fails before resolving/starting) must NOT report 4.0.0 as
        // installed, drop v3's discovered models, wipe v3 coordinator state, or reject v3 live updates—
        // even across repeated refreshes while 4.0.0 remains broken.
        remoteVersion = "4.0.0";
        failProbeSpawn = true;
        yield* realCatalog.invalidateIndex();
        const failedUpgradeWarning = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "warning"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const warningSnapshot = Option.getOrThrow(yield* Fiber.join(failedUpgradeWarning));
        expect(warningSnapshot.version).toBe("3.0.0");
        expect(warningSnapshot.models.map((model) => model.slug)).toEqual([
          "v3-model-a",
          "v3-model-b",
        ]);
        expect(warningSnapshot.slashCommands).toEqual([{ name: "v3-still-active" }]);
        expect(
          yield* coordinator.getAvailableCommands(identity.instanceId, {
            runtimeIdentity: v3Identity,
            requireMatchingRuntimeIdentity: true,
          }),
        ).toEqual(Option.some({ slashCommands: [{ name: "v3-still-active" }], skills: [] }));
        const v3AfterFailedUpgrade = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "v3-after-failed-v4"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v3-after-failed-v4" }], skills: [] },
          v3Identity,
        );
        expect(Option.isSome(yield* Fiber.join(v3AfterFailedUpgrade))).toBe(true);

        // A second refresh while 4.0.0 is still failing must stay on 3.0.0 without flickering to
        // 4.0.0 and must preserve v3's discovered models and live commands.
        const secondFailedRefreshSnapshots: Array<ServerProvider> = [];
        const secondFailedCollector = yield* instance.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              secondFailedRefreshSnapshots.push(snapshot);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const secondFailedDone = yield* Deferred.make<void>();
        onEnrichmentSpanEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(secondFailedDone, Exit.void);
          }
        };
        yield* instance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(secondFailedDone);
        onEnrichmentSpanEnd = null;
        yield* Fiber.interrupt(secondFailedCollector);
        expect(secondFailedRefreshSnapshots.every((snapshot) => snapshot.version === "3.0.0")).toBe(
          true,
        );
        const afterSecondFailed = yield* instance.snapshot.getSnapshot;
        expect(afterSecondFailed.version).toBe("3.0.0");
        expect(afterSecondFailed.status).toBe("warning");
        expect(afterSecondFailed.models.map((model) => model.slug)).toEqual([
          "v3-model-a",
          "v3-model-b",
        ]);
        expect(afterSecondFailed.slashCommands).toEqual([{ name: "v3-after-failed-v4" }]);

        // Once 4.0.0 recovers, the next refresh cleanly upgrades and clears the warning.
        failProbeSpawn = false;
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["v4-model-a", "v4-model-b"]));
        const recoveredToV4 = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "4.0.0" &&
              snapshot.status === "ready" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const v4Recovered = Option.getOrThrow(yield* Fiber.join(recoveredToV4));
        expect(v4Recovered.models.map((model) => model.slug)).toEqual(["v4-model-a", "v4-model-b"]);
        expect(v4Recovered.message).toBeUndefined();
        const v4Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v4Inspection.status).toBe("ready");
        const v4Identity = v4Inspection.status === "ready" ? v4Inspection.launchIdentity! : "";

        // 7. Rolling the shared registry back to a previously retired version (3.0.0) allows a new
        // 3.0.0 session's live state to reconcile the driver back to 3.0.0.
        remoteVersion = "3.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const rolledBackToV3 = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "3.0.0" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((command) => command.name === "v3-rollback-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v3-rollback-cmd" }], skills: [] },
          v3Identity,
        );
        expect(Option.isSome(yield* Fiber.join(rolledBackToV3))).toBe(true);

        // 8. If a live update parks in pendingReconcileIdentity while an upgrade probe is in flight
        // (while 3.0.0 is still displayed) and that probe fails, releasing inFlightProbeIdentity
        // first lets the parked identity drain and reconcile automatically without another event.
        remoteVersion = "4.0.0";
        yield* realCatalog.invalidateIndex();
        const v4ParkedGate = {
          matchVersion: "4.0.0",
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        resolveGate = v4ParkedGate;
        failProbeSpawnOnce = true;
        const v4ReconciledFromParked = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "4.0.0" &&
              snapshot.status === "ready" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((command) => command.name === "v4-parked-after-fail"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Deferred.await(v4ParkedGate.started);
        const v4ParkedHandled = yield* Deferred.make<void>();
        onCommandHandled = { matchName: "v4-parked-after-fail", done: v4ParkedHandled };
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v4-parked-after-fail" }], skills: [] },
          v4Identity,
        );
        // Wait for the watcher to park v4Identity in pendingReconcileIdentity while the probe is still blocked.
        yield* Deferred.await(v4ParkedHandled);
        yield* Deferred.succeed(v4ParkedGate.release, undefined);
        const reconciledFromParked = Option.getOrThrow(yield* Fiber.join(v4ReconciledFromParked));
        expect(reconciledFromParked.version).toBe("4.0.0");
        expect(reconciledFromParked.message).toBeUndefined();

        // 9. Disposing a driver instance removes its coordinator state and marks earlier metadata stale.
        const disposedInstanceId = ProviderInstanceId.make("acpRegistry_disposed_cleanup");
        const disposedScope = yield* Scope.make();
        let disposedMeta: AcpRegistryRuntimeCoordinator.AcpRegistryLiveUpdateMeta | null = null;
        const disposedWatched = yield* Deferred.make<void>();
        const disposedWatcher = yield* coordinator
          .watchAvailableCommands(disposedInstanceId, (_commands, meta) =>
            Effect.sync(() => {
              disposedMeta = meta;
            }).pipe(Effect.andThen(Deferred.succeed(disposedWatched, undefined)), Effect.asVoid),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* AcpRegistryDriver.create({
          instanceId: disposedInstanceId,
          displayName: "Disposed ACP",
          enabled: true,
          environment: [],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Scope.provide(disposedScope),
        );
        yield* coordinator.publishAvailableCommands(
          disposedInstanceId,
          { slashCommands: [{ name: "before-dispose" }], skills: [] },
          v3Identity,
        );
        yield* Deferred.await(disposedWatched);
        expect(disposedMeta).not.toBeNull();
        expect(yield* disposedMeta!.isCurrent).toBe(true);
        yield* Scope.close(disposedScope, Exit.void);
        expect(Option.isNone(yield* coordinator.getAvailableCommands(disposedInstanceId))).toBe(
          true,
        );
        expect(yield* disposedMeta!.isCurrent).toBe(false);
        yield* Fiber.interrupt(disposedWatcher);
      }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );

  it.effect(
    "preserves foreground-only live runtimes on upgrade failure, stamps fallback retirements at the failed target revision, and drains events arriving during in-flight reconciliation",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseCoordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const { directory, agentPath, modelsPath } = yield* seedInstalledBinaryAgent(
          "acp-driver-reconcile-edge-",
        );
        const authFailAgentPath = path.join(directory, "auth-fail-agent.mjs");
        const exitFailAgentPath = path.join(directory, "exit-fail-agent.mjs");
        const logoutAgentPath = path.join(directory, "logout-agent.mjs");
        const authLoginAgentPath = path.join(directory, "auth-login-agent.mjs");
        const versionlessLocalAgentPath = path.join(directory, "versionless-local-agent.mjs");
        yield* fileSystem.writeFileString(exitFailAgentPath, "process.exit(1);\n");
        yield* fileSystem.writeFileString(
          logoutAgentPath,
          fakeAgentSource.replace(
            "agentCapabilities: {}",
            "agentCapabilities: { auth: { logout: {} } }",
          ),
        );
        yield* fileSystem.writeFileString(
          authLoginAgentPath,
          fakeAgentSource.replace(
            "authMethods: []",
            'authMethods: [{ id: "agent-login", name: "Agent Login", type: "agent" }]',
          ),
        );
        yield* fileSystem.writeFileString(
          versionlessLocalAgentPath,
          fakeAgentSource.replace(
            'agentInfo: { name: "fake", version: "1.5.9" }',
            'agentInfo: { name: "fake", version: "" }',
          ),
        );
        yield* fileSystem.writeFileString(
          authFailAgentPath,
          `
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
        agentCapabilities: {},
        authMethods: [{ id: "api-key", name: "API key", type: "env_var", vars: [{ name: "API_KEY" }] }],
        agentInfo: { name: "fake", version: "2.0.0" },
      },
    });
  } else if (method === "session/new") {
    send({ id, error: { code: -32000, message: "Authentication required" } });
  } else {
    send({ id, result: {} });
  }
});
`,
        );

        let remoteVersion = "1.0.0";
        let remoteExtraAgentVersion: string | undefined = undefined;
        let failArchiveVersions = new Set<string>();
        let failProbeSpawn = false;
        let failProbeAuth = false;
        let failProbeExit = false;
        let useLogoutAgent = false;
        let useAuthLoginAgent = false;
        let probeResolveCount = 0;
        let defectInspectCount = 0;
        let interruptInspectOnce = false;
        let inspectCalls = 0;
        let onRefreshIndex: (() => Effect.Effect<void>) | null = null;
        let onBeforeProbeResolve: (() => Effect.Effect<void>) | null = null;
        let recordedInspectRevisions: Array<number | undefined> | null = null;
        let resolveGate: {
          readonly matchVersion: string;
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        let inspectGate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        let getAvailableCommandsGate: {
          readonly instanceId: ProviderInstanceId;
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
          readonly interrupted: Deferred.Deferred<void>;
        } | null = null;
        let onCommandHandled: {
          readonly matchName: string;
          readonly done: Deferred.Deferred<void>;
        } | null = null;
        let onConfigHandled: {
          readonly matchModelId: string;
          readonly done: Deferred.Deferred<void>;
        } | null = null;
        let onEnrichmentEnd: (() => void) | null = null;
        let onReconcileEnd: ((exit: Exit.Exit<unknown, unknown>) => void) | null = null;
        const enrichmentTracer: Tracer.Tracer = {
          span(options) {
            const inner = Tracer.nativeTracer.span(options);
            if (
              options.name !== "AcpRegistryDriver.publishEnrichment" &&
              options.name !== "AcpRegistryDriver.reconcileUnmatchedRuntime"
            ) {
              return inner;
            }
            const origEnd = inner.end.bind(inner);
            inner.end = (endTime, exit) => {
              origEnd(endTime, exit);
              if (options.name === "AcpRegistryDriver.publishEnrichment" && Exit.isSuccess(exit)) {
                const cb = onEnrichmentEnd;
                onEnrichmentEnd = null;
                cb?.();
              } else if (options.name === "AcpRegistryDriver.reconcileUnmatchedRuntime") {
                const cb = onReconcileEnd;
                onReconcileEnd = null;
                cb?.(exit);
              }
            };
            return inner;
          },
        };
        const coordinator: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"] =
          {
            ...baseCoordinator,
            getAvailableCommands: (instanceId, options) => {
              if (
                getAvailableCommandsGate !== null &&
                getAvailableCommandsGate.instanceId === instanceId
              ) {
                const gate = getAvailableCommandsGate;
                getAvailableCommandsGate = null;
                return Deferred.succeed(gate.started, undefined).pipe(
                  Effect.andThen(Deferred.await(gate.release)),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(gate.interrupted, undefined).pipe(Effect.asVoid),
                  ),
                  Effect.andThen(baseCoordinator.getAvailableCommands(instanceId, options)),
                );
              }
              return baseCoordinator.getAvailableCommands(instanceId, options);
            },
            watchAvailableCommands: (instanceId, onUpdate) =>
              baseCoordinator.watchAvailableCommands(instanceId, (commands, meta) =>
                onUpdate(commands, meta).pipe(
                  Effect.tap(() => {
                    if (
                      onCommandHandled !== null &&
                      commands.slashCommands.some((cmd) => cmd.name === onCommandHandled!.matchName)
                    ) {
                      const handled = onCommandHandled;
                      onCommandHandled = null;
                      return Deferred.succeed(handled.done, undefined).pipe(Effect.asVoid);
                    }
                    return Effect.void;
                  }),
                ),
              ),
            watchLiveConfiguration: (instanceId, onUpdate) =>
              baseCoordinator.watchLiveConfiguration(instanceId, (configuration, meta) =>
                onUpdate(configuration, meta).pipe(
                  Effect.tap(() => {
                    if (
                      onConfigHandled !== null &&
                      configuration.models.some(
                        (model) => model.id === onConfigHandled!.matchModelId,
                      )
                    ) {
                      const handled = onConfigHandled;
                      onConfigHandled = null;
                      return Deferred.succeed(handled.done, undefined).pipe(Effect.asVoid);
                    }
                    return Effect.void;
                  }),
                ),
              ),
          };
        const realCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: directory,
          toolsDir: path.join(directory, "tools"),
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, testHostPlatform),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              if (request.url === registryUrl) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      makeBinaryRegistry(
                        remoteVersion,
                        compatibleRegistryTarget,
                        remoteExtraAgentVersion
                          ? { extraAgentVersion: remoteExtraAgentVersion }
                          : undefined,
                      ),
                    ),
                  ),
                );
              }
              const failDownload = Array.from(failArchiveVersions).some((version) =>
                request.url.includes(`-${version}.bin`),
              );
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  failDownload
                    ? new Response("unavailable", { status: 503 })
                    : new Response(`#!/bin/sh\necho ${remoteVersion}\n`),
                ),
              );
            }),
          ),
        );
        const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
          ...realCatalog,
          refreshIndex: (options) =>
            Effect.gen(function* () {
              if (onRefreshIndex !== null) {
                const hook = onRefreshIndex;
                onRefreshIndex = null;
                yield* hook();
              }
              return yield* realCatalog.refreshIndex(options);
            }),
          inspect: (settings, environment) =>
            Effect.gen(function* () {
              inspectCalls += 1;
              if (interruptInspectOnce) {
                interruptInspectOnce = false;
                if (inspectGate !== null) {
                  const gate = inspectGate;
                  inspectGate = null;
                  yield* Deferred.succeed(gate.started, undefined);
                  yield* Deferred.await(gate.release);
                }
                return yield* Effect.interrupt;
              }
              if (defectInspectCount > 0) {
                defectInspectCount -= 1;
                if (inspectGate !== null) {
                  const gate = inspectGate;
                  inspectGate = null;
                  yield* Deferred.succeed(gate.started, undefined);
                  yield* Deferred.await(gate.release);
                }
                return yield* Effect.die("simulated reconcile inspect defect");
              }
              const result = yield* realCatalog.inspect(settings, environment);
              if (recordedInspectRevisions !== null) {
                recordedInspectRevisions.push(
                  "indexRevision" in result ? result.indexRevision : undefined,
                );
              }
              if (inspectGate !== null) {
                const gate = inspectGate;
                inspectGate = null;
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.release);
              }
              return result;
            }),
          resolve: (settings, cwd, environment) =>
            Effect.gen(function* () {
              if (environment?.MISE_OFFLINE === "1") {
                probeResolveCount += 1;
              }
              if (environment?.MISE_OFFLINE === "1" && onBeforeProbeResolve !== null) {
                const hook = onBeforeProbeResolve;
                onBeforeProbeResolve = null;
                yield* hook();
              }
              const resolved = yield* realCatalog.resolve(settings, cwd, environment);
              if (
                environment?.MISE_OFFLINE === "1" &&
                resolveGate !== null &&
                resolved.agent?.version === resolveGate.matchVersion
              ) {
                const gate = resolveGate;
                resolveGate = null;
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.release);
              }
              if (environment?.MISE_OFFLINE === "1" && failProbeSpawn) {
                return yield* new AcpRegistrySupport.AcpRegistryError({
                  reason: "install_failed",
                  detail: `Simulated probe install failure for ${resolved.agent?.version ?? "unknown"}.`,
                });
              }
              return {
                ...resolved,
                spawn: {
                  command: process.execPath,
                  args:
                    environment?.MISE_OFFLINE === "1" && failProbeExit
                      ? [exitFailAgentPath]
                      : environment?.MISE_OFFLINE === "1" && failProbeAuth
                        ? [authFailAgentPath]
                        : [
                            useAuthLoginAgent
                              ? authLoginAgentPath
                              : useLogoutAgent
                                ? logoutAgentPath
                                : agentPath,
                            modelsPath,
                          ],
                },
              };
            }),
        };

        // 1. Foreground startup skips initial 1.0.0 probe while live 1.0.0 sessions publish config
        // only OR commands only; when 2.0.0 later fails (including authentication_failed), each
        // snapshot retains 1.0.0 without copying 2.0.0's unauthenticated state onto 1.0.0.
        const fgConfigOnlyId = ProviderInstanceId.make("acpRegistry_fg_config_only_v1");
        const fgCmdOnlyId = ProviderInstanceId.make("acpRegistry_fg_cmd_only_v1");
        const fgStarted = yield* Deferred.make<void>();
        const releaseFg = yield* Deferred.make<void>();
        const fgFiber = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(fgStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFg))),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(fgStarted);

        const fgConfigInstance = yield* AcpRegistryDriver.create({
          instanceId: fgConfigOnlyId,
          displayName: "FG Config Only",
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
        );
        const fgCmdInstance = yield* AcpRegistryDriver.create({
          instanceId: fgCmdOnlyId,
          displayName: "FG Cmd Only",
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
        );
        const v1Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v1Inspection.status).toBe("ready");
        const v1Identity = v1Inspection.status === "ready" ? v1Inspection.launchIdentity! : "";
        const fgConfigLiveReady = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "1.0.0" &&
              snapshot.models.some((model) => model.slug === "fg-v1-a"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const fgCmdLiveReady = yield* fgCmdInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "1.0.0" &&
              snapshot.slashCommands.some((cmd) => cmd.name === "fg-v1-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* fgConfigInstance.snapshot.refresh;
        yield* fgCmdInstance.snapshot.refresh;
        yield* coordinator.publishLiveConfiguration(
          fgConfigOnlyId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "fg-v1-a",
            availableModels: [
              { modelId: "fg-v1-a", name: "fg-v1-a" },
              { modelId: "fg-v1-b", name: "fg-v1-b" },
            ],
          }),
          v1Identity,
        );
        yield* coordinator.publishAvailableCommands(
          fgCmdOnlyId,
          { slashCommands: [{ name: "fg-v1-cmd" }], skills: [] },
          v1Identity,
        );
        expect(Option.isSome(yield* Fiber.join(fgConfigLiveReady))).toBe(true);
        expect(Option.isSome(yield* Fiber.join(fgCmdLiveReady))).toBe(true);

        // End foreground startup, move index to 2.0.0 failing with authentication_failed, and
        // verify both 1.0.0 snapshots stay on 1.0.0 without copying 2.0.0's unauthenticated auth.
        yield* Deferred.succeed(releaseFg, undefined);
        yield* Fiber.join(fgFiber);
        remoteVersion = "2.0.0";
        failProbeAuth = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fgConfigWarning = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "warning"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const fgCmdWarning = yield* fgCmdInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "warning"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const fgConfigWarningDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fgConfigWarningDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        const fgConfigWarningSnapshot = Option.getOrThrow(yield* Fiber.join(fgConfigWarning));
        yield* Deferred.await(fgConfigWarningDone);
        const fgCmdWarningDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fgCmdWarningDone, Exit.void);
        yield* fgCmdInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        expect(fgConfigWarningSnapshot.version).toBe("1.0.0");
        expect(fgConfigWarningSnapshot.auth.status).toBe("unknown");
        expect(fgConfigWarningSnapshot.message).toContain("API key");
        expect(fgConfigWarningSnapshot.models.map((model) => model.slug)).toEqual([
          "fg-v1-a",
          "fg-v1-b",
        ]);
        const fgCmdWarningSnapshot = Option.getOrThrow(yield* Fiber.join(fgCmdWarning));
        yield* Deferred.await(fgCmdWarningDone);
        expect(fgCmdWarningSnapshot.version).toBe("1.0.0");
        expect(fgCmdWarningSnapshot.auth.status).toBe("unknown");
        expect(fgCmdWarningSnapshot.slashCommands).toEqual([{ name: "fg-v1-cmd" }]);

        // A live config update while retaining 1.0.0 under an upgrade failure must not bake the
        // transient upgrade warning message into lastSuccessfulRuntime: when 1.0.0 is rolled back
        // to and probed again, the old 2.0.0 warning message is gone.
        const fgConfigUpdatedDuringWarn = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((model) => model.slug === "fg-v1-c")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          fgConfigOnlyId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "fg-v1-c",
            availableModels: [
              { modelId: "fg-v1-a", name: "fg-v1-a" },
              { modelId: "fg-v1-c", name: "fg-v1-c" },
            ],
          }),
          v1Identity,
        );
        const warnedWithC = Option.getOrThrow(yield* Fiber.join(fgConfigUpdatedDuringWarn));
        expect(warnedWithC.message).toContain("API key");
        // Another refresh while 2.0.0 still fails must publish 1.0.0 with non-unauthenticated auth
        // and the auth warning once the second probe's enrichment actually completes.
        const secondAuthEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(secondAuthEnrichmentDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(secondAuthEnrichmentDone);
        const secondAuthPublished = yield* fgConfigInstance.snapshot.getSnapshot;
        expect(secondAuthPublished.version).toBe("1.0.0");
        expect(secondAuthPublished.status).toBe("warning");
        expect(secondAuthPublished.auth.status).toBe("unknown");
        expect(secondAuthPublished.message).toContain("API key");

        // Post-resolution authentication_failed uses the ACTUALLY RESOLVED runtime identity:
        // (a) inspect reads 1.0.0, resolve refreshes/launches 2.0.0 which fails auth -> retained
        //     1.0.0 stays auth.status === "unknown" (not marked unauthenticated).
        remoteVersion = "1.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        // Ensure 1.0.0 has a valid receipted install on disk for fallback check (b) below.
        yield* realCatalog.resolve(decodeSettings({ agentId: "test-agent" }), directory);
        onBeforeProbeResolve = () => {
          remoteVersion = "2.0.0";
          return realCatalog
            .invalidateIndex()
            .pipe(
              Effect.andThen(realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 })),
              Effect.ignore,
            );
        };
        const mismatchUpgradeDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(mismatchUpgradeDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(mismatchUpgradeDone);
        const mismatchUpgradeSnapshot = yield* fgConfigInstance.snapshot.getSnapshot;
        expect(mismatchUpgradeSnapshot.version).toBe("1.0.0");
        expect(mismatchUpgradeSnapshot.status).toBe("warning");
        expect(mismatchUpgradeSnapshot.auth.status).toBe("unknown");
        expect(mismatchUpgradeSnapshot.message).toContain("API key");

        // (b) inspect reads 2.0.0, resolve falls back to installed 1.0.0 (503 on 2.0.0), and
        //     1.0.0 fails auth -> 1.0.0's OWN auth.status becomes "unauthenticated".
        yield* fileSystem.remove(path.join(directory, "tools", "test-agent", "2.0.0"), {
          recursive: true,
          force: true,
        });
        remoteVersion = "2.0.0";
        failArchiveVersions = new Set(["2.0.0"]);
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackAuthDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fallbackAuthDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fallbackAuthDone);
        const fallbackAuthSnapshot = yield* fgConfigInstance.snapshot.getSnapshot;
        expect(fallbackAuthSnapshot.version).toBe("1.0.0");
        expect(fallbackAuthSnapshot.status).toBe("warning");
        expect(fallbackAuthSnapshot.auth.status).toBe("unauthenticated");
        expect(fallbackAuthSnapshot.message).toContain("API key");

        // A live config update while the active runtime itself is unauthenticated must preserve
        // warning status, unauthenticated auth, and sign-in guidance instead of flipping to ready.
        const unauthLiveUpdated = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((model) => model.slug === "fg-v1-d")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          fgConfigOnlyId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "fg-v1-d",
            availableModels: [
              { modelId: "fg-v1-a", name: "fg-v1-a" },
              { modelId: "fg-v1-d", name: "fg-v1-d" },
            ],
          }),
          v1Identity,
        );
        const unauthWithD = Option.getOrThrow(yield* Fiber.join(unauthLiveUpdated));
        expect(unauthWithD.status).toBe("warning");
        expect(unauthWithD.auth.status).toBe("unauthenticated");
        expect(unauthWithD.message).toContain("API key");

        // (c) Fallback auth failure records failedTarget.indexRevision so a refresh where resolve
        //     discovers a newer failing target (2.0.1) and falls back to 1.0.0 does not re-probe
        //     2.0.1 / 1.0.0 a second time inside the same refresh.
        failArchiveVersions = new Set(["2.0.0", "2.0.1"]);
        onBeforeProbeResolve = () => {
          remoteVersion = "2.0.1";
          return realCatalog
            .invalidateIndex()
            .pipe(
              Effect.andThen(realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 })),
              Effect.ignore,
            );
        };
        probeResolveCount = 0;
        const fallbackRevDedupDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fallbackRevDedupDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fallbackRevDedupDone);
        expect(probeResolveCount).toBe(1);

        // (d) A post-resolution non-auth failure after fallback (2.0.1 download fails, fallback
        //     1.0.0 exits immediately) must preserve warning + the real probe error and replace
        //     failedUpgradeTarget so the stale "API key" message does not return on live updates.
        failProbeAuth = false;
        failProbeExit = true;
        const fallbackExitDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fallbackExitDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fallbackExitDone);
        const fallbackExitSnapshot = yield* fgConfigInstance.snapshot.getSnapshot;
        expect(fallbackExitSnapshot.version).toBe("1.0.0");
        expect(fallbackExitSnapshot.status).toBe("warning");
        // Retains step (b)'s auth rejection rather than clearing it on a startup crash.
        expect(fallbackExitSnapshot.auth.status).toBe("unauthenticated");
        expect(fallbackExitSnapshot.message).toBeDefined();
        expect(fallbackExitSnapshot.message).not.toContain("API key");
        const exitLiveUpdated = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((model) => model.slug === "fg-v1-e")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          fgConfigOnlyId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "fg-v1-e",
            availableModels: [
              { modelId: "fg-v1-a", name: "fg-v1-a" },
              { modelId: "fg-v1-e", name: "fg-v1-e" },
            ],
          }),
          v1Identity,
        );
        const exitWithE = Option.getOrThrow(yield* Fiber.join(exitLiveUpdated));
        expect(exitWithE.status).toBe("warning");
        expect(exitWithE.message).toBeDefined();
        expect(exitWithE.message).not.toContain("API key");
        failProbeExit = false;

        // (e) Non-upgrade same-runtime auth failure clears failedUpgradeTarget and preserves
        //     warning + unauthenticated + sign-in message across live config updates via
        //     preserveUnauthenticated (without failedUpgradeTarget or activeFallback).
        failArchiveVersions = new Set();
        remoteVersion = "1.0.0";
        failProbeAuth = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const directUnauthDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(directUnauthDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(directUnauthDone);
        const directUnauthLive = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((model) => model.slug === "fg-v1-f")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          fgConfigOnlyId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "fg-v1-f",
            availableModels: [
              { modelId: "fg-v1-a", name: "fg-v1-a" },
              { modelId: "fg-v1-f", name: "fg-v1-f" },
            ],
          }),
          v1Identity,
        );
        const directUnauthWithF = Option.getOrThrow(yield* Fiber.join(directUnauthLive));
        expect(directUnauthWithF.status).toBe("warning");
        expect(directUnauthWithF.auth.status).toBe("unauthenticated");
        expect(directUnauthWithF.message).toContain("API key");

        // (f) After a successful fallback sets activeFallback, a subsequent auth rejection on the
        //     fallback runtime preserves the auth warning across live config updates (taking
        //     precedence over activeFallback's install notice) and clears activeFallback so
        //     subsequent refreshes don't mask it behind backoff.
        failProbeAuth = false;
        remoteVersion = "2.0.0";
        failArchiveVersions = new Set(["2.0.0"]);
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const activeFbReadyDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(activeFbReadyDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(activeFbReadyDone);
        expect((yield* fgConfigInstance.snapshot.getSnapshot).status).toBe("ready");
        expect((yield* fgConfigInstance.snapshot.getSnapshot).message).toContain("2.0.0");
        yield* TestClock.adjust("61 seconds");
        failProbeAuth = true;
        const activeFbUnauthDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(activeFbUnauthDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(activeFbUnauthDone);
        const activeFbUnauthLive = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((model) => model.slug === "fg-v1-g")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          fgConfigOnlyId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "fg-v1-g",
            availableModels: [
              { modelId: "fg-v1-a", name: "fg-v1-a" },
              { modelId: "fg-v1-g", name: "fg-v1-g" },
            ],
          }),
          v1Identity,
        );
        const activeFbWithG = Option.getOrThrow(yield* Fiber.join(activeFbUnauthLive));
        expect(activeFbWithG.status).toBe("warning");
        expect(activeFbWithG.auth.status).toBe("unauthenticated");
        expect(activeFbWithG.message).toContain("API key");
        // Follow-up refresh must never mask the rejection behind activeFallback or drop
        // latestAcceptedAuth during readiness (every emitted snapshot stays warning/unauthenticated).
        const followUpSnapshots: Array<ServerProvider> = [];
        const followUpCollector = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              followUpSnapshots.push(snapshot);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const activeFbFollowUpDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(activeFbFollowUpDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(activeFbFollowUpDone);
        yield* Fiber.interrupt(followUpCollector);
        expect(followUpSnapshots.length).toBeGreaterThan(0);
        for (const emitted of followUpSnapshots) {
          expect(emitted.status).toBe("warning");
          expect(emitted.auth.status).toBe("unauthenticated");
        }
        failProbeAuth = false;
        failArchiveVersions = new Set();
        remoteVersion = "2.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });

        // Now make 2.0.0 fail with a different install_failed message and verify the earlier
        // auth warning message did not leak into lastSuccessfulRuntime.
        failProbeSpawn = true;
        const fgSwitchedWarning = yield* fgConfigInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => Boolean(snapshot.message?.includes("2.0.0"))),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const fgSwitchedDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fgSwitchedDone, Exit.void);
        yield* fgConfigInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        const fgSwitchedSnapshot = Option.getOrThrow(yield* Fiber.join(fgSwitchedWarning));
        yield* Deferred.await(fgSwitchedDone);
        expect(fgSwitchedSnapshot.version).toBe("1.0.0");
        expect(fgSwitchedSnapshot.message).not.toContain("API key");
        expect(fgSwitchedSnapshot.models.map((model) => model.slug)).toContain("fg-v1-g");

        // 2. When no snapshot was ever accepted for 1.0.0 (neither probe nor live session), a failed
        // 2.0.0 probe discovered via recheck (with expectedRuntimeIdentity still on 1.0.0!) publishes
        // 2.0.0's failure snapshot without attaching 1.0.0 live state AND aligns watcher identities
        // to 2.0.0 so subsequent 1.0.0 updates cannot land on it.
        remoteVersion = "1.0.0";
        failProbeSpawn = false;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const coldFgStarted = yield* Deferred.make<void>();
        const releaseColdFg = yield* Deferred.make<void>();
        const coldFgDone = yield* Deferred.make<void>();
        const coldFgFiber = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(coldFgStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseColdFg)),
            ),
          )
          .pipe(
            Effect.ensuring(Deferred.succeed(coldFgDone, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
        yield* Deferred.await(coldFgStarted);
        const noAcceptId = ProviderInstanceId.make("acpRegistry_no_accepted_v1");
        // Drain makeManagedServerProvider's automatic startup enrichment before arming hooks
        // so it cannot consume onRefreshIndex out of order.
        const noAcceptStartupDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(noAcceptStartupDone, Exit.void);
        const noAcceptInstance = yield* AcpRegistryDriver.create({
          instanceId: noAcceptId,
          displayName: "No Accepted V1",
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(noAcceptStartupDone);
        const noAcceptColdEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(noAcceptColdEnrichmentDone, Exit.void);
        yield* noAcceptInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(noAcceptColdEnrichmentDone);
        // Keep disk registry.json on 1.0.0 and keep coldFgFiber held during initialProbe so
        // checkProvider sees 1.0.0 (expectedRuntimeIdentity === v1Identity), initialProbe skips,
        // and publishEnrichment's refreshIndex releases coldFgFiber and discovers failing 2.0.0.
        remoteVersion = "2.0.0";
        failProbeSpawn = true;
        yield* realCatalog.invalidateIndex();
        onRefreshIndex = () =>
          Deferred.succeed(releaseColdFg, undefined).pipe(
            Effect.andThen(Deferred.await(coldFgDone)),
          );
        const noAcceptWarning = yield* noAcceptInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "warning"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const noAcceptFailDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(noAcceptFailDone, Exit.void);
        yield* noAcceptInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        const noAcceptSnapshot = Option.getOrThrow(yield* Fiber.join(noAcceptWarning));
        yield* Deferred.await(noAcceptFailDone);
        yield* Fiber.join(coldFgFiber);
        expect(noAcceptSnapshot.version).toBe("2.0.0");
        expect(noAcceptSnapshot.message).toContain("2.0.0");
        expect(noAcceptSnapshot.slashCommands).toEqual([]);
        // A subsequent 1.0.0 update must NOT land on 2.0.0's failure snapshot (requires
        // runProbeAndPublish to have updated expectedRuntimeIdentity from v1Identity to v2Identity).
        const lateV1AfterFailHandled = yield* Deferred.make<void>();
        onCommandHandled = { matchName: "v1-after-v2-fail", done: lateV1AfterFailHandled };
        yield* coordinator.publishAvailableCommands(
          noAcceptId,
          { slashCommands: [{ name: "v1-after-v2-fail" }], skills: [] },
          v1Identity,
        );
        yield* Deferred.await(lateV1AfterFailHandled);
        const noAcceptAfterLateV1 = yield* noAcceptInstance.snapshot.getSnapshot;
        expect(noAcceptAfterLateV1.version).toBe("2.0.0");
        expect(noAcceptAfterLateV1.slashCommands).toEqual([]);
        // Once 2.0.0 succeeds, noAcceptInstance adopts 2.0.0 cleanly.
        failProbeSpawn = false;
        const noAcceptV2Adopted = yield* noAcceptInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "2.0.0" &&
              snapshot.status === "ready" &&
              snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const noAcceptV2AdoptedDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(noAcceptV2AdoptedDone, Exit.void);
        yield* noAcceptInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        expect(Option.isSome(yield* Fiber.join(noAcceptV2Adopted))).toBe(true);
        yield* Deferred.await(noAcceptV2AdoptedDone);

        // 3. Fallback retirement stamps failedTarget's revision (v3), not a concurrently restored
        // v4 revision, so a new v4 session reconciles immediately even if v4 restored mid-probe.
        failProbeSpawn = false;
        const fallbackRetireId = ProviderInstanceId.make("acpRegistry_fallback_retire_rev");
        remoteVersion = "2.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const controlledDispatcher = new Scheduler.MixedScheduler("async").makeDispatcher();
        const controlledScheduler: Scheduler.Scheduler = {
          executionMode: "async",
          shouldYield: () => false,
          makeDispatcher: () => controlledDispatcher,
        };
        const fallbackStartupDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fallbackStartupDone, Exit.void);
        const fallbackRetireInstance = yield* AcpRegistryDriver.create({
          instanceId: fallbackRetireId,
          displayName: "Fallback Retire Rev",
          enabled: true,
          environment: [{ name: "MISE_OFFLINE", value: "0", sensitive: false }],
          config: decodeSettings({ agentId: "test-agent" }),
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
          Effect.provideService(Scheduler.Scheduler, controlledScheduler),
        );
        yield* Deferred.await(fallbackStartupDone);
        const v2Ready = yield* fallbackRetireInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "2.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const v2ReadyDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(v2ReadyDone, Exit.void);
        yield* fallbackRetireInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
          Effect.provideService(Scheduler.Scheduler, controlledScheduler),
        );
        expect(Option.isSome(yield* Fiber.join(v2Ready))).toBe(true);
        yield* Deferred.await(v2ReadyDone);
        const v2Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v2Inspection.status).toBe("ready");
        const v2Identity = v2Inspection.status === "ready" ? v2Inspection.launchIdentity! : "";

        remoteVersion = "4.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const v4Ready = yield* fallbackRetireInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) => snapshot.version === "4.0.0" && snapshot.nativeSessions !== undefined,
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const v4InitialDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(v4InitialDone, Exit.void);
        yield* fallbackRetireInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
          Effect.provideService(Scheduler.Scheduler, controlledScheduler),
        );
        expect(Option.isSome(yield* Fiber.join(v4Ready))).toBe(true);
        yield* Deferred.await(v4InitialDone);
        const v4Inspection = yield* realCatalog.inspect(decodeSettings({ agentId: "test-agent" }));
        expect(v4Inspection.status).toBe("ready");
        const v4Identity = v4Inspection.status === "ready" ? v4Inspection.launchIdentity! : "";

        // Move upstream to failing 3.0.0 while keeping disk cache on 4.0.0 and only 2.0.0 on disk:
        // enrichment's index refresh discovers 3.0.0 (R3), fails download, and falls back to 2.0.0.
        // Pause during 2.0.0 fallback resolve while another caller restores 4.0.0 at R4 > R3.
        yield* fileSystem.remove(path.join(directory, "tools", "test-agent", "4.0.0"), {
          recursive: true,
          force: true,
        });
        remoteVersion = "3.0.0";
        failArchiveVersions = new Set(["3.0.0"]);
        yield* realCatalog.invalidateIndex();
        const v2FallbackGate = {
          matchVersion: "2.0.0",
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        resolveGate = v2FallbackGate;
        const v2FallbackPublished = yield* fallbackRetireInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "2.0.0" && Boolean(snapshot.message?.includes("3.0.0")),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const fallbackEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fallbackEnrichmentDone, Exit.void);
        yield* fallbackRetireInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
          Effect.provideService(Scheduler.Scheduler, controlledScheduler),
        );
        yield* Deferred.await(v2FallbackGate.started);
        remoteVersion = "4.0.0";
        failArchiveVersions = new Set();
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* Deferred.succeed(v2FallbackGate.release, undefined);
        expect(Option.isSome(yield* Fiber.join(v2FallbackPublished))).toBe(true);
        yield* Deferred.await(fallbackEnrichmentDone);

        // Because v4 was retired at R3 (not R4), a new v4 live update at R4 reconciles immediately.
        const v4Restored = yield* fallbackRetireInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "4.0.0" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((cmd) => cmd.name === "v4-restored-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const v4RestoredEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(v4RestoredEnrichmentDone, Exit.void);
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v4-restored-cmd" }], skills: [] },
          v4Identity,
        );
        expect(Option.isSome(yield* Fiber.join(v4Restored))).toBe(true);
        yield* Deferred.await(v4RestoredEnrichmentDone);

        // 4. An event arriving while a reconciliation inspect for the same identity is in flight
        // is parked and drained once the older inspection finishes, and unrelated revision bumps
        // re-stamp retirement so subsequent late updates do not repeat catalog.inspect.
        remoteExtraAgentVersion = "9.9.9";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const staleReconcileInspect = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        inspectGate = staleReconcileInspect;
        // First retired v2 event at unrelated revision R5 triggers a coalesced inspect (paused on gate).
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v2-stale-at-r5" }], skills: [] },
          v2Identity,
        );
        yield* Deferred.await(staleReconcileInspect.started);
        // While inspect #1 (at R5 = 4.0.0) is in flight, roll catalog back to 2.0.0 at R6 and send a new v2 update.
        remoteVersion = "2.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const v2ParkedHandled = yield* Deferred.make<void>();
        onCommandHandled = { matchName: "v2-during-reconcile", done: v2ParkedHandled };
        const v2DrainedReconciled = yield* fallbackRetireInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "2.0.0" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((cmd) => cmd.name === "v2-during-reconcile"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const v2RestoredEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(v2RestoredEnrichmentDone, Exit.void);
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v2-during-reconcile" }], skills: [] },
          v2Identity,
        );
        yield* Deferred.await(v2ParkedHandled);
        yield* Deferred.succeed(staleReconcileInspect.release, undefined);
        expect(Option.isSome(yield* Fiber.join(v2DrainedReconciled))).toBe(true);
        yield* Deferred.await(v2RestoredEnrichmentDone);

        // Verify re-stamping on an unrelated revision bump suppresses repeated inspects for retired v4,
        // waiting for the full reconciliation span (including retirement stamping and claim release)
        // before sending the second same-revision event and before advancing to the next revision.
        remoteExtraAgentVersion = "10.0.0";
        yield* realCatalog.invalidateIndex();
        const r7 = yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        recordedInspectRevisions = [];
        const firstRestampSpanDone = yield* Deferred.make<void>();
        onReconcileEnd = () => Deferred.doneUnsafe(firstRestampSpanDone, Exit.void);
        const inspectsBeforeRestamp = inspectCalls;
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v4-late-1" }], skills: [] },
          v4Identity,
        );
        yield* Deferred.await(firstRestampSpanDone);
        expect(inspectCalls).toBe(inspectsBeforeRestamp + 1);
        expect(recordedInspectRevisions).toEqual([r7]);

        // A second late v4 event at the same revision R7 must NOT trigger another reconcile inspect.
        const secondLateHandled = yield* Deferred.make<void>();
        onCommandHandled = { matchName: "v4-late-2", done: secondLateHandled };
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v4-late-2" }], skills: [] },
          v4Identity,
        );
        yield* Deferred.await(secondLateHandled);
        expect(inspectCalls).toBe(inspectsBeforeRestamp + 1);
        expect(recordedInspectRevisions).toEqual([r7]);

        // Advancing to a new unrelated revision R8 triggers exactly one more inspect (total [r7, r8]).
        remoteExtraAgentVersion = "10.0.1";
        yield* realCatalog.invalidateIndex();
        const r8 = yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const secondRestampSpanDone = yield* Deferred.make<void>();
        onReconcileEnd = () => Deferred.doneUnsafe(secondRestampSpanDone, Exit.void);
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v4-late-3" }], skills: [] },
          v4Identity,
        );
        yield* Deferred.await(secondRestampSpanDone);
        expect(inspectCalls).toBe(inspectsBeforeRestamp + 2);
        expect(recordedInspectRevisions).toEqual([r7, r8]);
        recordedInspectRevisions = null;

        // A defect inside reconciliation releases the reconcilingState claim AND replays a parked
        // pending event for the same identity once without needing a third event.
        remoteExtraAgentVersion = "10.0.2";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const defectInspectGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        inspectGate = defectInspectGate;
        defectInspectCount = 1;
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v4-defect-probe" }], skills: [] },
          v4Identity,
        );
        yield* Deferred.await(defectInspectGate.started);
        // While the defecting reconcile is in flight, restore 4.0.0 and park a second v4 event.
        remoteVersion = "4.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const parkedDuringDefectHandled = yield* Deferred.make<void>();
        onCommandHandled = { matchName: "v4-parked-on-defect", done: parkedDuringDefectHandled };
        const v4RecoveredByReplay = yield* fallbackRetireInstance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.version === "4.0.0" &&
              snapshot.nativeSessions !== undefined &&
              snapshot.slashCommands.some((cmd) => cmd.name === "v4-parked-on-defect"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const v4RecoveredEnrichmentDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(v4RecoveredEnrichmentDone, Exit.void);
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v4-parked-on-defect" }], skills: [] },
          v4Identity,
        );
        yield* Deferred.await(parkedDuringDefectHandled);
        yield* Deferred.succeed(defectInspectGate.release, undefined);
        expect(Option.isSome(yield* Fiber.join(v4RecoveredByReplay))).toBe(true);
        yield* Deferred.await(v4RecoveredEnrichmentDone);

        // A defect with no parked update does not self-loop, and scope interruption of a
        // reconciliation with a parked update does NOT replay (!Cause.hasInterruptsOnly).
        remoteExtraAgentVersion = "10.0.3";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        defectInspectCount = 1;
        const inspectsBeforeNoPending = inspectCalls;
        const noPendingDefectDone = yield* Deferred.make<void>();
        onReconcileEnd = () => Deferred.doneUnsafe(noPendingDefectDone, Exit.void);
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v2-defect-no-pending" }], skills: [] },
          v2Identity,
        );
        yield* Deferred.await(noPendingDefectDone);
        controlledDispatcher.flush();
        expect(inspectCalls).toBe(inspectsBeforeNoPending + 1);

        // Interruption of a reconciliation fiber while driverScope is still OPEN (with a parked
        // event) must NOT replay (!Cause.hasInterruptsOnly).
        const interruptGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        inspectGate = interruptGate;
        interruptInspectOnce = true;
        const inspectsBeforeInterrupt = inspectCalls;
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v2-interrupt-1" }], skills: [] },
          v2Identity,
        );
        yield* Deferred.await(interruptGate.started);
        const interruptParked = yield* Deferred.make<void>();
        onCommandHandled = { matchName: "v2-interrupt-2", done: interruptParked };
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v2-interrupt-2" }], skills: [] },
          v2Identity,
        );
        yield* Deferred.await(interruptParked);
        const interruptSpanDone = yield* Deferred.make<void>();
        onReconcileEnd = () => Deferred.doneUnsafe(interruptSpanDone, Exit.void);
        yield* Deferred.succeed(interruptGate.release, undefined);
        yield* Deferred.await(interruptSpanDone);
        controlledDispatcher.flush();
        const interruptBarrierHandled = yield* Deferred.make<void>();
        onCommandHandled = { matchName: "v4-interrupt-barrier", done: interruptBarrierHandled };
        yield* coordinator.publishAvailableCommands(
          fallbackRetireId,
          { slashCommands: [{ name: "v4-interrupt-barrier" }], skills: [] },
          v4Identity,
        );
        yield* Deferred.await(interruptBarrierHandled);
        controlledDispatcher.flush();
        expect(inspectCalls).toBe(inspectsBeforeInterrupt + 1);

        // 5. Saved sign-in confirmation: first-probe auth rejection clears it without
        //    lastSuccessfulRuntime, rejected publications keep it, and a later failure on B
        //    never restores confirmation after A rejected auth.
        const host = yield* ProviderHost.ProviderHost;
        const authConfirmId = ProviderInstanceId.make("acpRegistry_confirmed_auth_edge");
        const authConfirmEnv = [{ name: "MISE_OFFLINE", value: "0", sensitive: false }] as const;
        const authConfirmSettings = decodeSettings({ agentId: "test-agent" });
        const seedConfirmedAuth = () =>
          AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
            cacheDir: host.paths.providerStatusCacheDir,
            instanceId: authConfirmId,
            settings: authConfirmSettings,
            environment: authConfirmEnv,
            processEnvironment: process.env,
          });
        remoteVersion = "1.0.0";
        failProbeSpawn = false;
        failProbeExit = false;
        failProbeAuth = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* (yield* seedConfirmedAuth()).set(true);
        const firstRejectScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(firstRejectScope, Exit.void));
        const firstRejectStartupDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(firstRejectStartupDone, Exit.void);
        const firstRejectInstance = yield* AcpRegistryDriver.create({
          instanceId: authConfirmId,
          displayName: "Confirmed Auth Edge",
          enabled: true,
          environment: authConfirmEnv,
          config: authConfirmSettings,
        }).pipe(
          Scope.provide(firstRejectScope),
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(firstRejectStartupDone);
        expect((yield* firstRejectInstance.snapshot.getSnapshot).auth.status).toBe(
          "unauthenticated",
        );
        expect(yield* (yield* seedConfirmedAuth()).get).toBe(false);
        yield* Scope.close(firstRejectScope, Exit.void);

        // (b) & (c): Re-seed saved confirmation, verify stale rejected publication leaves it intact,
        //            verify B's auth failure preserves A's authenticated state, then A's own auth
        //            rejection clears it and a later B failure never restores old confirmation.
        yield* (yield* seedConfirmedAuth()).set(true);
        failProbeAuth = false;
        const authRetainStartupDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(authRetainStartupDone, Exit.void);
        const authRetainInstance = yield* AcpRegistryDriver.create({
          instanceId: authConfirmId,
          displayName: "Confirmed Auth Retain",
          enabled: true,
          environment: authConfirmEnv,
          config: authConfirmSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(authRetainStartupDone);
        expect((yield* authRetainInstance.snapshot.getSnapshot).auth.status).toBe("authenticated");

        // Start a 1.0.0 probe that rejects auth, pause it inside withLiveRuntimeState before
        // tryPublishSnapshot, and supersede it with a succeeding refresh -> confirmation stays true.
        yield* authRetainInstance.invalidateCaches ?? Effect.void;
        const staleUnauthGate = {
          matchVersion: "1.0.0",
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        resolveGate = staleUnauthGate;
        failProbeAuth = true;
        yield* authRetainInstance.snapshot.refresh;
        yield* Deferred.await(staleUnauthGate.started);
        const staleWithLiveStarted = yield* Deferred.make<void>();
        const staleWithLiveRelease = yield* Deferred.make<void>();
        const staleWithLiveInterrupted = yield* Deferred.make<void>();
        getAvailableCommandsGate = {
          instanceId: authConfirmId,
          started: staleWithLiveStarted,
          release: staleWithLiveRelease,
          interrupted: staleWithLiveInterrupted,
        };
        yield* Deferred.succeed(staleUnauthGate.release, undefined);
        // Wait until authFailAgentPath returned authentication_failed and entered withLiveRuntimeState.
        yield* Deferred.await(staleWithLiveStarted);
        failProbeAuth = false;
        const supersedingRefreshDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(supersedingRefreshDone, Exit.void);
        yield* authRetainInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(staleWithLiveInterrupted);
        yield* Deferred.await(supersedingRefreshDone);
        expect(yield* (yield* seedConfirmedAuth()).get).toBe(true);
        expect((yield* authRetainInstance.snapshot.getSnapshot).auth.status).toBe("authenticated");

        // B fails auth -> retained A keeps authenticated.
        remoteVersion = "2.0.0";
        failProbeAuth = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const bFailKeepAuthDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(bFailKeepAuthDone, Exit.void);
        yield* authRetainInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(bFailKeepAuthDone);
        expect((yield* authRetainInstance.snapshot.getSnapshot).auth.status).toBe("authenticated");

        // While A's 15m probe cache entry is still fresh, B's download fails (503) and fallback A
        // rejects auth -> invalidates A's cached probe so rolling back to A before TTL expires
        // does not serve stale cached unknown auth and erase the rejection.
        yield* fileSystem.remove(path.join(directory, "tools", "test-agent", "2.0.0"), {
          recursive: true,
          force: true,
        });
        failArchiveVersions = new Set(["2.0.0"]);
        const fallbackARejectDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fallbackARejectDone, Exit.void);
        yield* authRetainInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fallbackARejectDone);
        expect((yield* authRetainInstance.snapshot.getSnapshot).auth.status).toBe(
          "unauthenticated",
        );
        expect(yield* (yield* seedConfirmedAuth()).get).toBe(false);
        remoteVersion = "1.0.0";
        failArchiveVersions = new Set();
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const rollbackNoCacheDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(rollbackNoCacheDone, Exit.void);
        yield* authRetainInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(rollbackNoCacheDone);
        expect((yield* authRetainInstance.snapshot.getSnapshot).status).toBe("warning");
        expect((yield* authRetainInstance.snapshot.getSnapshot).auth.status).toBe(
          "unauthenticated",
        );

        // Now B fails without launching A -> retained A MUST stay unauthenticated (never restoring
        // A's old authenticated state from lastSuccessfulRuntime).
        remoteVersion = "2.0.0";
        failProbeAuth = false;
        failProbeSpawn = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const bFailAfterARejectDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(bFailAfterARejectDone, Exit.void);
        yield* authRetainInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(bFailAfterARejectDone);
        expect((yield* authRetainInstance.snapshot.getSnapshot).version).toBe("1.0.0");
        expect((yield* authRetainInstance.snapshot.getSnapshot).auth.status).toBe(
          "unauthenticated",
        );

        // (d) Logout invalidates confirmed authentication without restoring historical
        //     "authenticated" from lastSuccessfulRuntime on subsequent non-auth failures.
        failProbeSpawn = false;
        useLogoutAgent = true;
        remoteVersion = "1.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const logoutInstanceId = ProviderInstanceId.make("acpRegistry_logout_edge");
        const seedLogoutAuth = () =>
          AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
            cacheDir: host.paths.providerStatusCacheDir,
            instanceId: logoutInstanceId,
            settings: authConfirmSettings,
            environment: authConfirmEnv,
            processEnvironment: process.env,
          });
        yield* (yield* seedLogoutAuth()).set(true);
        const beforeLogoutDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(beforeLogoutDone, Exit.void);
        const logoutInstance = yield* AcpRegistryDriver.create({
          instanceId: logoutInstanceId,
          displayName: "Logout Edge",
          enabled: true,
          environment: authConfirmEnv,
          config: authConfirmSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(beforeLogoutDone);
        const beforeLogoutSnap = yield* logoutInstance.snapshot.getSnapshot;
        expect(beforeLogoutSnap.auth.status).toBe("authenticated");
        expect(beforeLogoutSnap.auth.canLogout).toBe(true);
        expect(beforeLogoutSnap.models.map((model) => model.slug)).toEqual(["model-a", "model-b"]);
        // Live config update while authenticated must also strip "authenticated" in lastSuccessfulRuntime.
        const logoutLiveUpdated = yield* logoutInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.some((model) => model.slug === "model-live")),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          logoutInstanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "model-live",
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-b", name: "model-b" },
              { modelId: "model-live", name: "model-live" },
            ],
          }),
          v1Identity,
        );
        expect(
          Option.getOrThrow(yield* Fiber.join(logoutLiveUpdated)).models.map((model) => model.slug),
        ).toEqual(["model-a", "model-b", "model-live"]);
        // Set failProbeSpawn before logout so logout's own refresh cannot overwrite
        // lastSuccessfulRuntime with a fresh probe before we assert auth.status === "unknown".
        failProbeSpawn = true;
        yield* logoutInstance.acpSessionManagement!.logout(directory);
        expect(yield* (yield* seedLogoutAuth()).get).toBe(false);
        // Same-runtime non-auth failure after logout must show unknown (never authenticated).
        const afterLogoutSameFailDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(afterLogoutSameFailDone, Exit.void);
        yield* logoutInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(afterLogoutSameFailDone);
        expect((yield* logoutInstance.snapshot.getSnapshot).status).toBe("warning");
        expect((yield* logoutInstance.snapshot.getSnapshot).auth.status).toBe("unknown");
        // Failed upgrade to 2.0.0 after logout keeps A's discovered models and stays unknown
        // across both retained-runtime publication and follow-up inspectReadiness.
        remoteVersion = "2.0.0";
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const afterLogoutUpgradeFailDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(afterLogoutUpgradeFailDone, Exit.void);
        yield* logoutInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(afterLogoutUpgradeFailDone);
        const afterLogoutUpgradeSnap = yield* logoutInstance.snapshot.getSnapshot;
        expect(afterLogoutUpgradeSnap.version).toBe("1.0.0");
        expect(afterLogoutUpgradeSnap.status).toBe("warning");
        expect(afterLogoutUpgradeSnap.auth.status).toBe("unknown");
        expect(afterLogoutUpgradeSnap.models.map((model) => model.slug)).toEqual([
          "model-a",
          "model-b",
          "model-live",
        ]);
        const afterLogoutSnapshots: Array<ServerProvider> = [];
        const afterLogoutCollector = yield* logoutInstance.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              afterLogoutSnapshots.push(snapshot);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const afterLogoutFollowUpDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(afterLogoutFollowUpDone, Exit.void);
        yield* logoutInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(afterLogoutFollowUpDone);
        yield* Fiber.interrupt(afterLogoutCollector);
        expect(afterLogoutSnapshots.length).toBeGreaterThan(0);
        for (const emitted of afterLogoutSnapshots) {
          expect(emitted.auth.status).not.toBe("authenticated");
        }

        // Foreground-skipped startup runtimes populated only via live commands or live config
        // while authenticated must also strip "authenticated" before logout + probe failure.
        remoteVersion = "1.0.0";
        failProbeSpawn = false;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fgLogoutStarted = yield* Deferred.make<void>();
        const releaseFgLogout = yield* Deferred.make<void>();
        const fgLogoutFiber = yield* coordinator
          .withForegroundStartup(
            "test-agent",
            Deferred.succeed(fgLogoutStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFgLogout)),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(fgLogoutStarted);
        const fgCmdLogoutId = ProviderInstanceId.make("acpRegistry_fg_cmd_logout");
        const fgCfgLogoutId = ProviderInstanceId.make("acpRegistry_fg_cfg_logout");
        const seedAuthFor = (id: ProviderInstanceId) =>
          AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
            cacheDir: host.paths.providerStatusCacheDir,
            instanceId: id,
            settings: authConfirmSettings,
            environment: authConfirmEnv,
            processEnvironment: process.env,
          });
        yield* (yield* seedAuthFor(fgCmdLogoutId)).set(true);
        yield* (yield* seedAuthFor(fgCfgLogoutId)).set(true);
        const fgCmdInitDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fgCmdInitDone, Exit.void);
        const fgCmdLogoutInstance = yield* AcpRegistryDriver.create({
          instanceId: fgCmdLogoutId,
          displayName: "FG Cmd Logout",
          enabled: true,
          environment: authConfirmEnv,
          config: authConfirmSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fgCmdInitDone);
        const fgCfgInitDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fgCfgInitDone, Exit.void);
        const fgCfgLogoutInstance = yield* AcpRegistryDriver.create({
          instanceId: fgCfgLogoutId,
          displayName: "FG Cfg Logout",
          enabled: true,
          environment: authConfirmEnv,
          config: authConfirmSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fgCfgInitDone);
        const fgCmdPopulated = yield* fgCmdLogoutInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((cmd) => cmd.name === "fg-logout-cmd"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const fgCfgPopulated = yield* fgCfgLogoutInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) => model.slug === "fg-logout-model"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          fgCmdLogoutId,
          { slashCommands: [{ name: "fg-logout-cmd" }], skills: [] },
          v1Identity,
        );
        yield* coordinator.publishLiveConfiguration(
          fgCfgLogoutId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "fg-logout-model",
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "fg-logout-model", name: "fg-logout-model" },
            ],
          }),
          v1Identity,
        );
        expect(Option.getOrThrow(yield* Fiber.join(fgCmdPopulated)).auth.status).toBe(
          "authenticated",
        );
        expect(Option.getOrThrow(yield* Fiber.join(fgCfgPopulated)).auth.status).toBe(
          "authenticated",
        );
        yield* Deferred.succeed(releaseFgLogout, undefined);
        yield* Fiber.join(fgLogoutFiber);
        failProbeSpawn = true;
        yield* fgCmdLogoutInstance.acpSessionManagement!.logout(directory);
        yield* fgCfgLogoutInstance.acpSessionManagement!.logout(directory);
        const fgCmdAfterLogoutDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fgCmdAfterLogoutDone, Exit.void);
        yield* fgCmdLogoutInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fgCmdAfterLogoutDone);
        const fgCfgAfterLogoutDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(fgCfgAfterLogoutDone, Exit.void);
        yield* fgCfgLogoutInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(fgCfgAfterLogoutDone);
        const fgCmdAfterLogout = yield* fgCmdLogoutInstance.snapshot.getSnapshot;
        expect(fgCmdAfterLogout.auth.status).toBe("unknown");
        expect(fgCmdAfterLogout.slashCommands).toEqual([{ name: "fg-logout-cmd" }]);
        const fgCfgAfterLogout = yield* fgCfgLogoutInstance.snapshot.getSnapshot;
        expect(fgCfgAfterLogout.auth.status).toBe("unknown");
        expect(fgCfgAfterLogout.models.map((model) => model.slug)).toEqual([
          "model-a",
          "fg-logout-model",
        ]);
        useLogoutAgent = false;
        failProbeSpawn = false;

        // Live config update while unauthenticated must not bake "unauthenticated" into
        // lastSuccessfulRuntime: signing in again then failing probe promotes back to authenticated.
        useAuthLoginAgent = true;
        const reauthId = ProviderInstanceId.make("acpRegistry_unauth_live_reauth");
        const reauthStartupDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(reauthStartupDone, Exit.void);
        const reauthInstance = yield* AcpRegistryDriver.create({
          instanceId: reauthId,
          displayName: "Unauth Live Reauth",
          enabled: true,
          environment: authConfirmEnv,
          config: authConfirmSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(reauthStartupDone);
        yield* TestClock.adjust("16 minutes");
        failProbeAuth = true;
        const reauthUnauthDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(reauthUnauthDone, Exit.void);
        yield* reauthInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(reauthUnauthDone);
        expect((yield* reauthInstance.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
        const reauthLiveUpdated = yield* reauthInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) => model.slug === "reauth-live-model"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          reauthId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "reauth-live-model",
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "reauth-live-model", name: "reauth-live-model" },
            ],
          }),
          v1Identity,
        );
        expect(Option.getOrThrow(yield* Fiber.join(reauthLiveUpdated)).auth.status).toBe(
          "unauthenticated",
        );
        failProbeAuth = false;
        failProbeSpawn = true;
        const reauthAuthFinished = yield* reauthInstance.auth!.subscribe("reauth-owner").pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const reauthPostSignInDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(reauthPostSignInDone, Exit.void);
        yield* reauthInstance
          .auth!.start("reauth-owner", Effect.void, "agent-login")
          .pipe(Effect.provideService(Tracer.Tracer, enrichmentTracer));
        expect(Option.getOrThrow(yield* Fiber.join(reauthAuthFinished)).phase).toBe("succeeded");
        yield* Deferred.await(reauthPostSignInDone);
        const reauthAfterSignIn = yield* reauthInstance.snapshot.getSnapshot;
        expect(reauthAfterSignIn.status).toBe("ready");
        expect(reauthAfterSignIn.auth.status).toBe("authenticated");
        expect(reauthAfterSignIn.models.map((model) => model.slug)).toEqual([
          "model-a",
          "reauth-live-model",
        ]);
        // Subsequent refresh checkProvider commit must keep authenticated via latestAuthConfirmed.
        const reauthCheckedDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(reauthCheckedDone, Exit.void);
        const reauthChecked = yield* reauthInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        expect(reauthChecked.auth.status).toBe("authenticated");
        yield* Deferred.await(reauthCheckedDone);
        useAuthLoginAgent = false;
        failProbeSpawn = false;

        // (e) Cold-start direct-publish branch clears saved confirmation when fallback runtime
        //     rejects auth so the next refresh does not flash authenticated.
        const coldFallbackAuthId = ProviderInstanceId.make("acpRegistry_cold_fallback_unauth");
        const seedColdFallbackAuth = () =>
          AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
            cacheDir: host.paths.providerStatusCacheDir,
            instanceId: coldFallbackAuthId,
            settings: authConfirmSettings,
            environment: authConfirmEnv,
            processEnvironment: process.env,
          });
        yield* fileSystem.remove(path.join(directory, "tools", "test-agent", "3.0.0"), {
          recursive: true,
          force: true,
        });
        remoteVersion = "3.0.0";
        failArchiveVersions = new Set(["3.0.0"]);
        failProbeAuth = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* (yield* seedColdFallbackAuth()).set(true);
        const coldFallbackDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(coldFallbackDone, Exit.void);
        const coldFallbackInstance = yield* AcpRegistryDriver.create({
          instanceId: coldFallbackAuthId,
          displayName: "Cold Fallback Unauth",
          enabled: true,
          environment: authConfirmEnv,
          config: authConfirmSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(coldFallbackDone);
        const coldFallbackSnap = yield* coldFallbackInstance.snapshot.getSnapshot;
        expect(coldFallbackSnap.version).toBe("2.0.0");
        expect(coldFallbackSnap.status).toBe("warning");
        expect(coldFallbackSnap.auth.status).toBe("unauthenticated");
        expect(yield* (yield* seedColdFallbackAuth()).get).toBe(false);
        const coldFollowUpSnaps: Array<ServerProvider> = [];
        const coldFollowUpCollector = yield* coldFallbackInstance.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              coldFollowUpSnaps.push(snapshot);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const coldFollowUpDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(coldFollowUpDone, Exit.void);
        yield* coldFallbackInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(coldFollowUpDone);
        yield* Fiber.interrupt(coldFollowUpCollector);
        expect(coldFollowUpSnaps.length).toBeGreaterThan(0);
        for (const emitted of coldFollowUpSnaps) {
          expect(emitted.auth.status).not.toBe("authenticated");
        }

        // (f) Local agent (previousIdentity === null, normal branch): a superseded auth rejection
        //     keeps saved confirmation intact, while an accepted auth rejection clears it.
        const localUnauthId = ProviderInstanceId.make("acpRegistry_local_unauth");
        const localUnauthSettings = decodeSettings({
          source: "local",
          commandPath: "local-auth-fail",
        });
        const localUnauthEnv = [{ name: "MISE_OFFLINE", value: "0", sensitive: false }] as const;
        const seedLocalAuth = () =>
          AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
            cacheDir: host.paths.providerStatusCacheDir,
            instanceId: localUnauthId,
            settings: localUnauthSettings,
            environment: localUnauthEnv,
            processEnvironment: process.env,
          });
        yield* (yield* seedLocalAuth()).set(true);
        let localFailAuth = true;
        let localUseVersionless = false;
        let localProbeCount = 0;
        let localResolveGate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        const localWithLiveStarted = yield* Deferred.make<void>();
        const localWithLiveRelease = yield* Deferred.make<void>();
        const localWithLiveInterrupted = yield* Deferred.make<void>();
        let localGateArmed = false;
        const localCatalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
          ...catalogWithInspection({
            status: "ready",
            agentId: "local-auth-fail",
            version: null,
            distribution: "local",
          }),
          resolve: (_settings, _cwd, environment) =>
            Effect.gen(function* () {
              if (environment?.MISE_OFFLINE === "1") {
                localProbeCount += 1;
                if (!localGateArmed) {
                  localGateArmed = true;
                  getAvailableCommandsGate = {
                    instanceId: localUnauthId,
                    started: localWithLiveStarted,
                    release: localWithLiveRelease,
                    interrupted: localWithLiveInterrupted,
                  };
                }
                if (localResolveGate !== null) {
                  const gate = localResolveGate;
                  localResolveGate = null;
                  yield* Deferred.succeed(gate.started, undefined);
                  yield* Deferred.await(gate.release);
                }
              }
              return {
                distribution: "local" as const,
                spawn: {
                  command: process.execPath,
                  args: localFailAuth
                    ? [authFailAgentPath]
                    : [localUseVersionless ? versionlessLocalAgentPath : agentPath, modelsPath],
                  cwd: directory,
                  env: process.env,
                },
              };
            }),
        };
        // Startup probe runs with previousIdentity === null (normal branch), fails auth, and pauses
        // inside withLiveRuntimeState before tryPublishSnapshot; superseding refresh keeps auth.
        const localUnauthInstance = yield* AcpRegistryDriver.create({
          instanceId: localUnauthId,
          displayName: "Local Unauth",
          enabled: true,
          environment: localUnauthEnv,
          config: localUnauthSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, localCatalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(localWithLiveStarted);
        localFailAuth = false;
        const localSupersedingDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(localSupersedingDone, Exit.void);
        yield* localUnauthInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(localWithLiveInterrupted);
        yield* Deferred.await(localSupersedingDone);
        expect(yield* (yield* seedLocalAuth()).get).toBe(true);
        expect((yield* localUnauthInstance.snapshot.getSnapshot).auth.status).toBe("authenticated");
        // Accepted normal-branch local auth rejection clears saved confirmation.
        const localAcceptedId = ProviderInstanceId.make("acpRegistry_local_unauth_accepted");
        const seedLocalAcceptedAuth = () =>
          AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
            cacheDir: host.paths.providerStatusCacheDir,
            instanceId: localAcceptedId,
            settings: localUnauthSettings,
            environment: localUnauthEnv,
            processEnvironment: process.env,
          });
        yield* (yield* seedLocalAcceptedAuth()).set(true);
        localFailAuth = true;
        const localUnauthDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(localUnauthDone, Exit.void);
        const localAcceptedInstance = yield* AcpRegistryDriver.create({
          instanceId: localAcceptedId,
          displayName: "Local Unauth Accepted",
          enabled: true,
          environment: localUnauthEnv,
          config: localUnauthSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, localCatalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(localUnauthDone);
        expect((yield* localAcceptedInstance.snapshot.getSnapshot).auth.status).toBe(
          "unauthenticated",
        );
        expect(yield* (yield* seedLocalAcceptedAuth()).get).toBe(false);
        // Version-less local agent (entryIdentity === null): an accepted auth rejection must evict
        // the cached probe entry so a live config update cannot revive it on the next refresh.
        localUseVersionless = true;
        localFailAuth = false;
        const localVersionlessId = ProviderInstanceId.make("acpRegistry_local_versionless_cache");
        const localVersionlessReadyDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(localVersionlessReadyDone, Exit.void);
        const localVersionlessInstance = yield* AcpRegistryDriver.create({
          instanceId: localVersionlessId,
          displayName: "Local Versionless Cache",
          enabled: true,
          environment: localUnauthEnv,
          config: localUnauthSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, localCatalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(localVersionlessReadyDone);
        expect((yield* localVersionlessInstance.snapshot.getSnapshot).version).toBeNull();
        expect((yield* localVersionlessInstance.snapshot.getSnapshot).status).toBe("ready");
        yield* TestClock.adjust("16 minutes");
        localFailAuth = true;
        const localVersionlessUnauthDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(localVersionlessUnauthDone, Exit.void);
        yield* localVersionlessInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(localVersionlessUnauthDone);
        expect((yield* localVersionlessInstance.snapshot.getSnapshot).auth.status).toBe(
          "unauthenticated",
        );
        const localVersionlessLive = yield* localVersionlessInstance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) => model.slug === "local-unauth-live"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const localVersionlessConfigHandled = yield* Deferred.make<void>();
        onConfigHandled = {
          matchModelId: "local-unauth-live",
          done: localVersionlessConfigHandled,
        };
        yield* coordinator.publishLiveConfiguration(
          localVersionlessId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "local-unauth-live",
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "local-unauth-live", name: "local-unauth-live" },
            ],
          }),
        );
        expect(Option.getOrThrow(yield* Fiber.join(localVersionlessLive)).auth.status).toBe(
          "unauthenticated",
        );
        // Wait until the watcher callback finishes (including cache update) before refreshing.
        yield* Deferred.await(localVersionlessConfigHandled);
        const probesBeforeRecheck = localProbeCount;
        const localVersionlessRecheckDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(localVersionlessRecheckDone, Exit.void);
        yield* localVersionlessInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(localVersionlessRecheckDone);
        expect(localProbeCount).toBe(probesBeforeRecheck + 1);
        const localVersionlessAfter = yield* localVersionlessInstance.snapshot.getSnapshot;
        expect(localVersionlessAfter.status).toBe("warning");
        expect(localVersionlessAfter.auth.status).toBe("unauthenticated");
        expect(localVersionlessAfter.message).toContain("API key");

        // (g) A refresh checkProvider that read confirmedAuthentication=true before an in-flight
        //     enrichment probe accepted an auth rejection must NOT commit auth.status="authenticated".
        const raceAuthId = ProviderInstanceId.make("acpRegistry_check_vs_reject_race");
        const seedRaceAuth = () =>
          AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
            cacheDir: host.paths.providerStatusCacheDir,
            instanceId: raceAuthId,
            settings: localUnauthSettings,
            environment: localUnauthEnv,
            processEnvironment: process.env,
          });
        yield* (yield* seedRaceAuth()).set(true);
        localFailAuth = true;
        const raceProbeStarted = yield* Deferred.make<void>();
        const raceProbeRelease = yield* Deferred.make<void>();
        localResolveGate = { started: raceProbeStarted, release: raceProbeRelease };
        const raceAuthInstance = yield* AcpRegistryDriver.create({
          instanceId: raceAuthId,
          displayName: "Check vs Reject Race",
          enabled: true,
          environment: localUnauthEnv,
          config: localUnauthSettings,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, localCatalog),
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            coordinator,
          ),
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
        );
        yield* Deferred.await(raceProbeStarted);
        const raceCheckStarted = yield* Deferred.make<void>();
        const raceCheckRelease = yield* Deferred.make<void>();
        const raceCheckInterrupted = yield* Deferred.make<void>();
        getAvailableCommandsGate = {
          instanceId: raceAuthId,
          started: raceCheckStarted,
          release: raceCheckRelease,
          interrupted: raceCheckInterrupted,
        };
        const raceRefreshFiber = yield* raceAuthInstance.snapshot.refresh.pipe(
          Effect.provideService(Tracer.Tracer, enrichmentTracer),
          Effect.forkScoped({ startImmediately: true }),
        );
        // Refresh gen 2 already observed confirmedAuthentication=true and paused in checkProvider.
        yield* Deferred.await(raceCheckStarted);
        const raceGen1RejectDone = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(raceGen1RejectDone, Exit.void);
        yield* Deferred.succeed(raceProbeRelease, undefined);
        yield* Deferred.await(raceGen1RejectDone);
        expect((yield* raceAuthInstance.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
        expect(yield* (yield* seedRaceAuth()).get).toBe(false);
        const raceSnapsAfterReject: Array<ServerProvider> = [];
        const raceCollector = yield* raceAuthInstance.snapshot.streamChanges.pipe(
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              raceSnapsAfterReject.push(snapshot);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const raceGen2Done = yield* Deferred.make<void>();
        onEnrichmentEnd = () => Deferred.doneUnsafe(raceGen2Done, Exit.void);
        yield* Deferred.succeed(raceCheckRelease, undefined);
        yield* Fiber.join(raceRefreshFiber);
        yield* Deferred.await(raceGen2Done);
        yield* Fiber.interrupt(raceCollector);
        expect(raceSnapsAfterReject.length).toBeGreaterThan(0);
        for (const emitted of raceSnapsAfterReject) {
          expect(emitted.auth.status).not.toBe("authenticated");
        }
        const raceFinal = yield* raceAuthInstance.snapshot.getSnapshot;
        expect(raceFinal.status).toBe("warning");
        expect(raceFinal.auth.status).toBe("unauthenticated");
      }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );
});
