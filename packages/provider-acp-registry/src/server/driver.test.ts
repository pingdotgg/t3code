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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

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

  it("ignores live updates tagged for a different runtime identity than the cached entry", () => {
    const provider = providerWithModels(
      [{ id: "smodel", name: "Default", description: null }],
      "smodel",
    );
    const cache = {
      invalidationGeneration: 3,
      liveGenerationByRuntime: new Map<string | null, number>(),
      entry: { provider, expiresAt: 1_000, launchIdentity: "runtime-v1" },
    };

    const ignored = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
      runtimeIdentity: "runtime-v2",
    });

    expect(ignored).toBe(cache);
    expect(ignored.invalidationGeneration).toBe(3);
    expect(ignored.liveGenerationByRuntime.size).toBe(0);
    expect(ignored.entry?.provider.models.map((m) => m.slug)).toEqual(["smodel"]);
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
    "publishes cold and cached probes immediately without waiting for a slow registry refresh",
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
        let failArchiveDownload = false;
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
                        makeBinaryRegistry(
                          remoteVersion,
                          compatibleRegistryTarget,
                          remoteWebsite ? { website: remoteWebsite } : undefined,
                        ),
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
          backoffSnapshots.every((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "v3-live-cmd"),
          ),
        ).toBe(true);

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

        // A freshly created instance on a cached failing 5.0.0 index falls back to 4.0.0 in a single
        // probe without double-probing when refreshIndex does not advance the revision.
        remoteVersion = "5.0.0";
        failArchiveDownload = true;
        yield* realCatalog.invalidateIndex();
        yield* realCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const resolvesBeforeFreshFallback = probeResolveAttempts;
        const freshFallbackDone = yield* Deferred.make<void>();
        onEnrichmentEnd = (exit) => {
          if (Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(freshFallbackDone, Exit.void);
          }
        };
        const freshInstance = yield* AcpRegistryDriver.create({
          instanceId: ProviderInstanceId.make("acpRegistry_fallback_single_probe"),
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
        expect((yield* freshInstance.snapshot.getSnapshot).version).toBe("4.0.0");
        expect(probeResolveAttempts).toBe(resolvesBeforeFreshFallback + 1);
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
        let inspectCalls = 0;
        let resolveGate: {
          readonly matchVersion: string;
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        let onInspectCallback: (() => Effect.Effect<void>) | null = null;
        let queuedStaleConfigGate: {
          readonly entered: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
          readonly matchSlug: string;
        } | null = null;
        const coordinator: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"] =
          {
            ...baseCoordinator,
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
              if (environment?.MISE_OFFLINE === "1" && failProbeSpawn) {
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
        yield* instance.snapshot.refresh;
        yield* Deferred.await(v1ProbeGate.started);
        const v1NewerLiveApplied = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) => model.slug === "v1-newer-live-a"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          identity.instanceId,
          normalizeAcpRegistryLiveConfiguration([], undefined, {
            currentModelId: "v1-newer-live-a",
            availableModels: [
              { modelId: "v1-newer-live-a", name: "v1-newer-live-a" },
              { modelId: "v1-newer-live-b", name: "v1-newer-live-b" },
            ],
          }),
          v1Identity,
        );
        expect(Option.isSome(yield* Fiber.join(v1NewerLiveApplied))).toBe(true);
        yield* Deferred.succeed(v1ProbeGate.release, undefined);
        const v1SettledAfterRelease = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.slashCommands.some((command) => command.name === "v1-after-superseded-probe"),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishAvailableCommands(
          identity.instanceId,
          { slashCommands: [{ name: "v1-after-superseded-probe" }], skills: [] },
          v1Identity,
        );
        const v1AfterSuperseded = Option.getOrThrow(yield* Fiber.join(v1SettledAfterRelease));
        yield* Fiber.interrupt(v1ProbeCollector);
        expect(v1AfterSuperseded.models.map((model) => model.slug)).toEqual([
          "v1-newer-live-a",
          "v1-newer-live-b",
        ]);
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
        expect(inspectCalls).toBe(inspectsBeforeRetiredV1);
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
        // installed, wipe v3 coordinator state, or reject subsequent v3 live updates.
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
        failProbeSpawn = false;

        // 7. Disposing a driver instance removes its coordinator state and marks earlier metadata stale.
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
});
