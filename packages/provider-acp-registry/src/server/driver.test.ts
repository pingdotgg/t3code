import {
  AcpRegistryOperationError,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { vi } from "vite-plus/test";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as AcpRegistryAuth from "./auth.ts";
import * as AcpRegistryProbe from "./probe.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { recordAcpRegistryModelOptions, type AcpRegistryLiveConfiguration } from "./probe.ts";
import {
  AcpRegistryDriver,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driver.ts";

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

const liveState = (latest: AcpRegistryLiveConfiguration) => ({
  latest,
  modelOptions: recordAcpRegistryModelOptions(new Map(), latest),
});

function thinkingChoices(provider: ServerProvider): Record<string, ReadonlyArray<string>> {
  return Object.fromEntries(
    provider.models.map((model) => [
      model.slug,
      (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
        descriptor.id === "thought_level" && descriptor.type === "select"
          ? descriptor.options.map((choice) => choice.id)
          : [],
      ),
    ]),
  );
}

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

describe("acpRegistrySnapshotReadiness", () => {
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
        liveState({ models: [], currentModelId: null, configOptions: [] }),
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
        liveState({
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        }),
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
        liveState({ models: [], currentModelId: null, configOptions: [] }),
        [],
      ).models,
    ).toEqual(provider.models);

    // A session that names no model cannot say which model its options describe.
    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        liveState({
          models: [],
          currentModelId: null,
          configOptions: [
            {
              id: "effort",
              label: "Effort",
              type: "select" as const,
              options: [{ id: "high", label: "High" }],
              currentValue: "high",
            },
          ],
        }),
        [],
      ).models,
    ).toEqual(provider.models);
  });

  it("describes discovered session options only on the model they belong to", () => {
    const probedOn = (currentModelId: string | null) =>
      buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({ agentId: "devin", customModels: ["custom-model"] }),
        checkedAt: "2026-10-03T10:00:00.000Z",
        inspection: { status: "ready", agentId: "devin", version: "1.0.0", distribution: "binary" },
        probe: {
          probe: {
            instanceId: identity.instanceId,
            ready: true,
            icon: null,
            authMethods: [],
            models: [
              { id: "opus", name: "Opus", description: null },
              { id: "glm", name: "GLM", description: null },
            ],
            currentModelId,
            configOptions: [
              {
                id: "thought_level",
                label: "Thinking",
                type: "select" as const,
                options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
                currentValue: "medium",
              },
            ],
            sessionManagement: noSessionManagement,
          },
          slashCommands: [],
          skills: [],
        },
      });

    expect(thinkingChoices(probedOn("opus"))).toEqual({
      opus: ["low", "medium", "high"],
      glm: [],
      "custom-model": [],
    });
    expect(thinkingChoices(probedOn(null))).toEqual({ opus: [], glm: [], "custom-model": [] });
  });

  it.effect("keeps probe and live session options per model until sign-in is lost", () =>
    Effect.gen(function* () {
      const probes = yield* Queue.unbounded<AcpRegistryLiveConfiguration>();
      const probe = vi
        .spyOn(AcpRegistryProbe, "probeAcpRegistryConfiguration")
        .mockImplementation(() =>
          Queue.take(probes).pipe(
            Effect.map((configuration) => ({
              probe: {
                ...configuration,
                instanceId: identity.instanceId,
                ready: true,
                icon: null,
                authMethods: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [],
              skills: [],
            })),
          ),
        );
      const auth = vi.spyOn(AcpRegistryAuth, "makeAcpRegistryAuth").mockImplementation((input) =>
        ProviderAuthFlow.make({
          instanceId: input.instanceId,
          credentialBinding: { owner: "provider", key: input.instanceId },
          methods: Effect.succeed([]),
          authenticate: () => Effect.die("unused authentication"),
          logout: Effect.void,
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          probe.mockRestore();
          auth.mockRestore();
        }),
      );
      const models = [
        { id: "opus", name: "Opus", description: null },
        { id: "glm", name: "GLM", description: null },
      ];
      const observed = (currentModelId: string, levels: ReadonlyArray<string>) => ({
        models,
        currentModelId,
        configOptions:
          levels.length === 0
            ? []
            : [
                {
                  id: "thought_level",
                  label: "Thinking",
                  type: "select" as const,
                  options: levels.map((id) => ({ id, label: id })),
                },
              ],
      });
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      });
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const nextSnapshot = Effect.fn(function* (
        accept: (snapshot: ServerProvider) => boolean,
        trigger: Effect.Effect<void>,
      ) {
        const updated = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(accept),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* trigger;
        return thinkingChoices(Option.getOrThrow(yield* Fiber.join(updated)));
      });
      const probed = (configuration: AcpRegistryLiveConfiguration) =>
        nextSnapshot(
          (snapshot) => snapshot.nativeSessions !== undefined,
          Queue.offer(probes, configuration),
        );
      const live = (configuration: AcpRegistryLiveConfiguration) =>
        nextSnapshot(
          (snapshot) => snapshot.message === undefined,
          coordinator.publishLiveConfiguration(identity.instanceId, configuration),
        );

      expect(yield* probed(observed("opus", ["low", "high"]))).toEqual({
        opus: ["low", "high"],
        glm: [],
      });
      expect(yield* live(observed("glm", ["max"]))).toEqual({
        opus: ["low", "high"],
        glm: ["max"],
      });
      // A live session overrides the probe, even when it reports no options.
      expect(yield* live(observed("opus", []))).toEqual({ opus: [], glm: ["max"] });

      yield* instance.auth!.invalidate!;
      expect(yield* probed(observed("glm", ["high"]))).toEqual({ opus: [], glm: ["high"] });
    }).pipe(
      Effect.provideService(
        AcpRegistrySupport.AcpRegistryCatalog,
        catalogWithInspection({
          status: "ready",
          agentId: "test-agent",
          version: "1.0.0",
          distribution: "binary",
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          TestProviderHost.layer({ runBackgroundWork: false }),
          IdAllocator.layer,
          McpProviderSessions.layer,
          AcpRegistryRuntimeCoordinator.layer,
          Digest.layerWebCrypto,
          SecureRandom.layerWebCrypto,
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

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
});
