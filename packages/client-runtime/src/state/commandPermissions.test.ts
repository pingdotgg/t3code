import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  EnvironmentId,
  InferenceProxyError,
  isInferenceProviderConfig,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
  type PeerLinkSummary,
  type InferenceRouteInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import { SshConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  SshConnectionTarget,
  type NetworkStatus,
} from "../connection/model.ts";
import {
  createInferenceProxyAtoms,
  inferenceFallbackKey,
  inferenceFallbackRetryDelay,
  planInferenceFallbacks,
  type InferenceFleetEnvironment,
} from "./inferenceProxy.ts";
import { createPeerLinkEnvironmentAtoms } from "./peerLinks.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("checks consumer permission before requesting an inference grant from the host", () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      registry.mount(sessions(other));
      registry.set(sessions(other), AsyncResult.success(grant(false)));
      const contacted: EnvironmentId[] = [];
      const routeRuntime = Atom.runtime(
        Layer.mock(EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map(),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          run: (id) => {
            contacted.push(id);
            return Effect.die("unexpected connection");
          },
        }),
      );
      const { routeInference } = createInferenceProxyAtoms(routeRuntime);
      const result = yield* Effect.promise(() =>
        routeInference.run(registry, {
          host: { environmentId: env, label: "Host" },
          consumer: { environmentId: other, label: "Consumer" },
          driver: "codex",
        }),
      );
      expect(contacted).toEqual([]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
    }),
  );
  it.effect.each([
    { via: "the connected SSH host", ssh: true, mode: "explicit" },
    {
      via: "the grant when this client reaches the host over loopback",
      ssh: false,
      mode: "explicit",
    },
    { via: "a connected SSH fallback", ssh: true, mode: "fallback" },
    { via: "a paired host discovered at first enable", ssh: true, mode: "discovery" },
    { via: "a saved route without enabling the provider globally", ssh: true, mode: "preserve" },
    {
      via: "an older consumer that cannot preserve provider enablement",
      ssh: true,
      mode: "legacy",
    },
    { via: "only the environment chosen for local setup", ssh: true, mode: "local-only" },
    { via: "a revoked host discovered at first enable", ssh: true, mode: "revoked" },
  ])("handles $via without forwarding the client's bearer credential", ({ ssh, mode }) =>
    Effect.gen(function* () {
      const registry = yield* setup;
      registry.mount(sessions(other));
      for (const id of [env, other])
        registry.set(
          sessions(id),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthProvidersManageScope],
            permissions: [AuthProvidersManageScope],
          }),
        );
      const target = new SshConnectionTarget({
        environmentId: env,
        label: "Host",
        connectionId: "ssh",
      });
      const profile = new SshConnectionProfile({
        environmentId: env,
        label: "Host",
        connectionId: "ssh",
        target: { alias: "host", hostname: "host.local", username: "user", port: 22 },
      });
      const issued = {
        hostId: env,
        consumerId: other,
        baseUrl: "t3-environment:target",
        key: "scoped-inference-key",
      };
      let selected: InferenceRouteInput | undefined;
      let automaticGrant: boolean | undefined;
      let selectedMethod: string | undefined;
      const discovery = mode !== "explicit" && mode !== "fallback";
      const localOnly = mode === "local-only";
      const legacyConsumer = mode === "legacy";
      const preserveProviderEnabled = mode === "preserve" || legacyConsumer;
      const fallback = mode === "fallback";
      const checkedHosts: EnvironmentId[] = [];
      const hostStatus = {
        running: true,
        enabled: true,
        sharing: true,
        version: "8.0.76",
        problem: null,
        accounts: [],
        availableDrivers: ["codex"],
        consumers: [],
        routes: [],
      } as const;
      const host = {
        target,
        prepared: yield* SubscriptionRef.make(
          Option.some({
            environmentId: env,
            label: "Host",
            target,
            httpBaseUrl: "http://127.0.0.1:43210",
            socketUrl: "ws://127.0.0.1:43210",
            httpAuthorization: { _tag: "Bearer", token: "must-stay-on-the-client" },
          }),
        ),
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.inferenceStatus]: () => {
                checkedHosts.push(env);
                return Effect.succeed(hostStatus);
              },
              [WS_METHODS.inferenceGrant]: (input: { automatic?: boolean }) => {
                automaticGrant = input.automatic;
                return mode === "revoked" && input.automatic
                  ? Effect.fail(new InferenceProxyError({ message: "Sharing was revoked." }))
                  : Effect.succeed(issued);
              },
            },
          } as unknown as RpcSession),
        ),
      } as EnvironmentSupervisor["Service"];
      const consumer = {
        target: new BearerConnectionTarget({
          environmentId: other,
          label: "Consumer",
          connectionId: "consumer",
        }),
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.inferenceStatus]: () => {
                checkedHosts.push(other);
                return Effect.succeed({
                  ...hostStatus,
                  sharing: false,
                  availableDrivers: ["claudeAgent"],
                });
              },
              [WS_METHODS.inferenceConnect]: (input: InferenceRouteInput) =>
                Effect.sync(() => {
                  selected = input;
                  selectedMethod = WS_METHODS.inferenceConnect;
                }),
              [WS_METHODS.inferenceRegisterFallback]: (input: InferenceRouteInput) =>
                Effect.sync(() => {
                  selected = input;
                  selectedMethod = WS_METHODS.inferenceRegisterFallback;
                }),
            },
          } as unknown as RpcSession),
        ),
      } as EnvironmentSupervisor["Service"];
      const routeRuntime = Atom.runtime(
        Layer.mock(EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map([
              [
                env,
                {
                  target,
                  profile: ssh ? Option.some(profile) : Option.none(),
                  enabled: true,
                },
              ],
            ]),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          run: (id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor, id === env ? host : consumer),
        }),
      );
      const { routeInference, enableInferenceRouting } = createInferenceProxyAtoms(routeRuntime);
      const hostIdentity = { environmentId: env, label: "Host" };
      const consumerIdentity = { environmentId: other, label: "Consumer" };
      const serverConfig = {
        environment: {
          capabilities: {
            inferenceProxy: true,
            inferenceRoutePreservesEnablement: !legacyConsumer,
          },
        },
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
            },
          },
        },
      } as InferenceFleetEnvironment["serverConfig"];
      const result = discovery
        ? yield* Effect.promise(() =>
            enableInferenceRouting.run(registry, {
              consumer: consumerIdentity,
              driver: "codex",
              ...(localOnly ? { onlyHostId: other } : {}),
              ...(preserveProviderEnabled ? { preserveProviderEnabled } : {}),
              environments: [
                { ...hostIdentity, connection: { phase: "offline" }, serverConfig },
                { ...hostIdentity, connection: { phase: "connected" }, serverConfig },
                { ...consumerIdentity, connection: { phase: "connected" }, serverConfig },
              ],
            }),
          )
        : yield* Effect.promise(() =>
            routeInference.run(registry, {
              host: hostIdentity,
              consumer: consumerIdentity,
              driver: "codex",
              fallback,
            }),
          );
      if (legacyConsumer) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Cause.squash(result.cause)).toMatchObject({
            message: expect.stringContaining("without enabling the provider globally"),
          });
        expect(checkedHosts).toEqual([]);
        expect(selected).toBeUndefined();
        return;
      }
      expect(automaticGrant).toBe(!localOnly && (fallback || discovery) ? true : undefined);
      expect(checkedHosts).toEqual(localOnly ? [other] : discovery ? [other, env] : []);
      if (localOnly) {
        expect(result._tag).toBe("Failure");
        expect(selected).toBeUndefined();
        return;
      }
      if (mode === "revoked") {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Cause.squash(result.cause)).toMatchObject({
            message: expect.stringContaining("Sharing was revoked."),
          });
        expect(selected).toBeUndefined();
        return;
      }
      expect(result._tag).toBe("Success");
      if (discovery && result._tag === "Success") expect(result.value).toEqual(hostIdentity);
      expect(selectedMethod).toBe(
        fallback ? WS_METHODS.inferenceRegisterFallback : WS_METHODS.inferenceConnect,
      );
      expect(selected).toEqual({
        grant: issued,
        driver: "codex",
        hostLabel: "Host",
        ...(preserveProviderEnabled ? { preserveProviderEnabled } : {}),
        ...(ssh ? { connection: { url: "http://127.0.0.1:43210", ssh: profile.target } } : {}),
      });
    }),
  );
  it("discovers only connected sharing hosts for a routed provider on another host", () => {
    const host: InferenceFleetEnvironment = {
      environmentId: env,
      label: "Studio",
      connection: { phase: "connected" },
      serverConfig: null,
    };
    const consumer: InferenceFleetEnvironment = {
      environmentId: other,
      label: "Spark",
      connection: { phase: "connected" },
      serverConfig: {
        settings: {
          providerInstances: {
            claudeAgent: {
              driver: "claudeAgent",
              config: {
                inferenceEnabled: true,
                inferenceHostId: EnvironmentId.make("m5"),
                inferenceHostLabel: "M5",
                inferenceBaseUrl: "http://192.168.0.55:3773/api/inference",
                inferenceKey: "saved-key",
                inferenceModels: ["claude-fable-5-2"],
                inferenceHomePath: "/state/claude",
              },
            },
          },
        },
      } as unknown as InferenceFleetEnvironment["serverConfig"],
    };
    const status = {
      enabled: true,
      sharing: true,
      running: true,
      version: "8.0.76",
      problem: null,
      accounts: [],
      availableDrivers: ["claudeAgent"],
      consumers: [],
      routes: [],
    } as const;
    expect(planInferenceFallbacks(host, status, [consumer])).toEqual([
      {
        host: { environmentId: env, label: "Studio" },
        consumer: { environmentId: other, label: "Spark" },
        driver: "claudeAgent",
        fallback: true,
      },
    ]);
    expect(planInferenceFallbacks(host, { ...status, sharing: false }, [consumer])).toEqual([]);
    const config = consumer.serverConfig!;
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const instance = config.settings.providerInstances[instanceId]!;
    if (!isInferenceProviderConfig(instance.config)) throw new Error("Expected a configured route");
    const disabledSettings = {
      ...config.settings,
      projectSettingsOverrides: {},
      providerInstances: {
        [instanceId]: { ...instance, config: { ...instance.config, enabled: false } },
      },
    };
    const disabled = { ...consumer, serverConfig: { ...config, settings: disabledSettings } };
    expect(planInferenceFallbacks(host, status, [disabled])).toEqual([]);
    const enabledInProject = {
      ...disabled,
      serverConfig: {
        ...config,
        settings: {
          ...disabledSettings,
          projectSettingsOverrides: {
            [ProjectId.make("inference-project")]: {
              providerInstances: { [instanceId]: { enabled: true } },
            },
          },
        },
      },
    };
    expect(planInferenceFallbacks(host, status, [enabledInProject])).toHaveLength(1);
    expect(
      planInferenceFallbacks({ ...host, connection: { phase: "offline" } }, status, [consumer]),
    ).toEqual([]);
    const original = inferenceFallbackKey(host, consumer, "claudeAgent", status);
    const reroutedConsumer: InferenceFleetEnvironment = {
      ...consumer,
      serverConfig: {
        settings: {
          providerInstances: {
            claudeAgent: {
              driver: "claudeAgent",
              config: {
                inferenceEnabled: true,
                inferenceHostId: EnvironmentId.make("another-host"),
                inferenceHostLabel: "Another host",
                inferenceBaseUrl: "http://192.168.0.56:3773/api/inference",
                inferenceKey: "saved-key",
                inferenceModels: ["claude-fable-5-2"],
                inferenceHomePath: "/state/claude",
              },
            },
          },
        },
      } as unknown as InferenceFleetEnvironment["serverConfig"],
    };
    const rerouted = inferenceFallbackKey(host, reroutedConsumer, "claudeAgent", status);
    expect(rerouted).not.toBe(original);
    expect(
      inferenceFallbackKey(host, consumer, "claudeAgent", {
        ...status,
        accounts: [
          { name: "Claude", provider: "claudeAgent", status: "ready", availability: "available" },
        ],
      }),
    ).not.toBe(original);
    expect([1, 2, 3, 4, 5].map(inferenceFallbackRetryDelay)).toEqual([
      60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });
  it.effect("requires the destination orchestration grant to mutate project knowledge", () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const mutate = createCommandPermissions(runtime, WS_METHODS.projectKnowledgeMutate);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      registry.set(sessions(other), AsyncResult.success(grant(false)));
      expect(registry.get(mutate.permissionAtom(env))).toBe(true);
      expect(registry.get(mutate.permissionAtom(other))).toBe(false);
      yield* mutate.authorize(registry, env);
      expect((yield* mutate.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    }),
  );

  it.effect("requires the destination read grant to refresh providers", () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const refresh = createCommandPermissions(runtime, WS_METHODS.serverRefreshProviders);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(refresh.permissionAtom(env))).toBe(false);
      expect((yield* refresh.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthOrchestrationReadScope],
          permissions: [AuthOrchestrationReadScope],
        }),
      );
      expect(registry.get(refresh.permissionAtom(env))).toBe(true);
      yield* refresh.authorize(registry, env);
      registry.set(sessions(other), AsyncResult.success(grant(false)));
      expect(registry.get(refresh.permissionAtom(other))).toBe(false);
      expect((yield* refresh.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      expect(registry.get(refresh.permissionAtom(env))).toBe(false);
      expect((yield* refresh.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    }),
  );

  it.effect("requires the destination preview grant to close a browser tab", () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const close = createCommandPermissions(runtime, WS_METHODS.previewClose);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(close.permissionAtom(env))).toBe(false);
      expect((yield* close.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthPreviewOperateScope],
          permissions: [AuthPreviewOperateScope],
        }),
      );
      expect(registry.get(close.permissionAtom(env))).toBe(true);
      yield* close.authorize(registry, env);
      registry.set(sessions(other), AsyncResult.success(grant(false)));
      expect(registry.get(close.permissionAtom(other))).toBe(false);
      expect((yield* close.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    }),
  );

  it.effect("requires the destination provider grant to manage an account or inference route", () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      for (const tag of [
        WS_METHODS.providerAuthRemoveMethod,
        WS_METHODS.inferenceStatus,
        WS_METHODS.inferenceManage,
        WS_METHODS.inferenceGrant,
        WS_METHODS.inferenceConnect,
      ] as const) {
        const remove = createCommandPermissions(runtime, tag);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(remove.permissionAtom(env))).toBe(false);
        expect((yield* remove.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthProvidersManageScope],
            permissions: [AuthProvidersManageScope],
          }),
        );
        expect(registry.get(remove.permissionAtom(env))).toBe(true);
        yield* remove.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(remove.permissionAtom(other))).toBe(false);
      }
    }),
  );

  it.effect.each([
    { method: WS_METHODS.serverRunStorageCleanup, scope: AuthSettingsWriteScope },
    { method: WS_METHODS.serverReclaimDatabaseSpace, scope: AuthEnvironmentMaintainScope },
  ])("requires the destination $scope grant for $method", ({ method, scope }) =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const command = createCommandPermissions(runtime, method);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(command.permissionAtom(env))).toBe(false);
      expect((yield* command.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      registry.set(
        sessions(env),
        AsyncResult.success({ ...grant(true), scopes: [scope], permissions: [scope] }),
      );
      expect(registry.get(command.permissionAtom(env))).toBe(true);
      yield* command.authorize(registry, env);
      registry.set(sessions(other), AsyncResult.success(grant(false)));
      expect(registry.get(command.permissionAtom(other))).toBe(false);
    }),
  );

  it.effect.each([
    WS_METHODS.serverCheckOtlpEndpoint,
    WS_METHODS.serverCheckSecretSource,
    WS_METHODS.serverRefreshSkillsLibrary,
    WS_METHODS.modelEvaluationsClear,
  ])("requires the destination settings grant for %s", (method) =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const check = createCommandPermissions(runtime, method);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(check.permissionAtom(env))).toBe(false);
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthSettingsWriteScope],
          permissions: [AuthSettingsWriteScope],
        }),
      );
      expect(registry.get(check.permissionAtom(env))).toBe(true);
      yield* check.authorize(registry, env);
    }),
  );

  it.effect("requires the destination settings grant to connect or bind an issue tracker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const connect = createCommandPermissions(runtime, WS_METHODS.issueTrackersConnect);
        const bind = createCommandPermissions(runtime, WS_METHODS.issueTrackersBindProject);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(connect.permissionAtom(env))).toBe(false);
        expect(registry.get(bind.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(connect.permissionAtom(env))).toBe(true);
        expect(registry.get(bind.permissionAtom(env))).toBe(true);
        yield* connect.authorize(registry, env);
        yield* bind.authorize(registry, env);
      }),
    ),
  );

  it.effect.each([
    WS_METHODS.scheduledTasksDelete,
    ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
    ORCHESTRATION_V2_WS_METHODS.threadGroupInvite,
    ORCHESTRATION_V2_WS_METHODS.threadGroupRemove,
    ORCHESTRATION_V2_WS_METHODS.threadGroupEnd,
  ])("uses the target grant for both availability and execution of %s", (method) =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const permissions = createCommandPermissions(runtime, method);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(permissions.permissionAtom(env))).toBe(true);
      expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
      yield* permissions.authorize(registry, env);
      registry.set(sessions(other), AsyncResult.success(grant(false)));
      expect(registry.get(permissions.permissionAtom(other))).toBe(false);
      const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
      expect(denied._tag).toBe("EnvironmentAuthorizationError");
    }),
  );
  it.effect("waits for an initial grant", () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      yield* Fiber.join(fiber);
    }),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
        expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success({ ...grant(true), authenticated: false }));
        expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
        yield* permissions.authorize(registry, env);
      }),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
        AuthSourceControlWriteScope,
      );
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        }),
      );
      yield* git.authorize(registry, env);
      const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
      const input = {
        cwd: "/repo",
        reference: "123",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      };
      expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
      expect((yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope).toBe(
        AuthOrchestrationOperateScope,
      );
      yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(true),
          scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
        }),
      );
      expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
      yield* prepare.authorize(registry, env, input);
    }),
);

it.effect.each(["commit", "push", "commit_push", "create_pr", "commit_push_pr"] as const)(
  "%s needs thread read permission only when generating a PR from a thread",
  (action) =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const command = createCommandPermissions(runtime, WS_METHODS.gitRunStackedAction);
      const input = { actionId: "action", cwd: "/repo", action };
      const withThread = { ...input, threadId: ThreadId.make("thread") };
      const session = {
        ...grant(false),
        scopes: [AuthSourceControlWriteScope],
        permissions: [AuthSourceControlWriteScope],
      };
      registry.set(sessions(env), AsyncResult.success(session));
      expect(registry.get(command.permissionAtom(env, input))).toBe(true);
      yield* command.authorize(registry, env, input);
      const readsThread = action === "create_pr" || action === "commit_push_pr";
      expect(registry.get(command.permissionAtom(env, withThread))).toBe(!readsThread);
      if (readsThread) {
        expect(yield* command.authorize(registry, env, withThread).pipe(Effect.flip)).toMatchObject(
          { requiredPermission: AuthOrchestrationReadScope },
        );
      } else {
        yield* command.authorize(registry, env, withThread);
      }
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...session,
          scopes: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
          permissions: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
        }),
      );
      expect(registry.get(command.permissionAtom(env, withThread))).toBe(true);
      yield* command.authorize(registry, env, withThread);
    }),
);

it.effect(
  "refreshes linked environments after permitted writes and blocks a read-only session",
  () =>
    Effect.gen(function* () {
      const registry = yield* setup;
      const peer: PeerLinkSummary = {
        environmentId: EnvironmentId.make("peer"),
        label: "Box",
        urls: ["https://box.example.test"],
        access: "auto",
        linkedAt: DateTime.makeUnsafe("2026-10-01T12:00:00Z"),
        expiresAt: DateTime.makeUnsafe("2026-10-31T12:00:00Z"),
        lastReachedAt: null,
        lastError: null,
        status: "reachable",
      };
      let links: ReadonlyArray<PeerLinkSummary> = [];
      const client = {
        [WS_METHODS.peerLinksList]: () => Effect.sync(() => ({ links })),
        [WS_METHODS.peerLinksLink]: vi.fn(() =>
          Effect.sync(() => {
            links = [peer];
            return peer;
          }),
        ),
        [WS_METHODS.peerLinksUnlink]: vi.fn(() =>
          Effect.sync(() => {
            links = [];
            return { removed: true };
          }),
        ),
      };
      const supervisor = {
        target: new BearerConnectionTarget({
          environmentId: env,
          label: "Test",
          connectionId: "test",
        }),
        session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
      } as EnvironmentSupervisor["Service"];
      const peerRuntime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry, {
          run: (id, effect) => {
            expect(id).toBe(env);
            return Effect.provideService(effect, EnvironmentSupervisor, supervisor);
          },
          followStream: (id, stream) => {
            expect(id).toBe(env);
            return Stream.provideService(stream, EnvironmentSupervisor, supervisor);
          },
        } as EnvironmentRegistry["Service"]),
      );
      const peerLinks = createPeerLinkEnvironmentAtoms(peerRuntime);
      const list = peerLinks.list({ environmentId: env, input: {} });
      registry.mount(list);
      const readLinks = AtomRegistry.getResult(registry, list, { suspendOnWaiting: true });
      const setAccess = (writable: boolean) =>
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthAccessReadScope, ...(writable ? [AuthAccessWriteScope] : [])],
            permissions: [AuthAccessReadScope, ...(writable ? [AuthAccessWriteScope] : [])],
          }),
        );
      registry.mount(sessions(other));
      registry.set(
        sessions(other),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthAccessWriteScope],
          permissions: [AuthAccessWriteScope],
        }),
      );
      setAccess(false);
      expect(yield* readLinks).toEqual({ links: [] });
      const linkInput = { url: peer.urls[0]!, pairingCode: "test-code", access: peer.access };
      const link = Effect.promise(() =>
        peerLinks.link.run(registry, { environmentId: env, input: linkInput }),
      );
      const unlink = Effect.promise(() =>
        peerLinks.unlink.run(registry, {
          environmentId: env,
          input: { environmentId: peer.environmentId },
        }),
      );
      expect(registry.get(peerLinks.link.permissionAtom(env))).toBe(false);
      const deniedLink = yield* link;
      expect(deniedLink._tag).toBe("Failure");
      if (deniedLink._tag === "Failure") {
        expect(Cause.squash(deniedLink.cause)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthAccessWriteScope,
        });
      }
      expect(client[WS_METHODS.peerLinksLink]).not.toHaveBeenCalled();
      setAccess(true);
      expect(registry.get(peerLinks.link.permissionAtom(env))).toBe(true);
      expect((yield* link)._tag).toBe("Success");
      expect(client[WS_METHODS.peerLinksLink]).toHaveBeenCalledExactlyOnceWith(linkInput);
      expect(yield* readLinks).toEqual({ links: [peer] });

      setAccess(false);
      expect(registry.get(peerLinks.unlink.permissionAtom(env))).toBe(false);
      const deniedUnlink = yield* unlink;
      expect(deniedUnlink._tag).toBe("Failure");
      if (deniedUnlink._tag === "Failure") {
        expect(Cause.squash(deniedUnlink.cause)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthAccessWriteScope,
        });
      }
      expect(client[WS_METHODS.peerLinksUnlink]).not.toHaveBeenCalled();
      expect(yield* readLinks).toEqual({ links: [peer] });
      setAccess(true);
      expect(registry.get(peerLinks.unlink.permissionAtom(env))).toBe(true);
      expect((yield* unlink)._tag).toBe("Success");
      expect(client[WS_METHODS.peerLinksUnlink]).toHaveBeenCalledExactlyOnceWith({
        environmentId: peer.environmentId,
      });
      expect(yield* readLinks).toEqual({ links: [] });
    }),
);

it.effect("requires access management to answer a link request", () =>
  Effect.gen(function* () {
    const registry = yield* setup;
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    const answer = createCommandPermissions(runtime, WS_METHODS.peerLinksAnswerRequest);
    expect(registry.get(answer.permissionAtom(env))).toBe(false);
    expect((yield* answer.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
      AuthAccessWriteScope,
    );
    registry.set(
      sessions(env),
      AsyncResult.success({
        ...grant(false),
        scopes: [AuthAccessWriteScope],
        permissions: [AuthAccessWriteScope],
      }),
    );
    expect(registry.get(answer.permissionAtom(env))).toBe(true);
    yield* answer.authorize(registry, env);
  }),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.gen(function* () {
    const registry = yield* setup;
    const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
    registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
    expect(registry.get(git.permissionAtom(env))).toBe(false);
    const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
    expect(denied).toMatchObject({
      requiredPermission: AuthSourceControlWriteScope,
      requiredScope: AuthOrchestrationOperateScope,
    });
    const { permissions: _exact, ...legacy } = grant(true);
    registry.set(sessions(env), AsyncResult.success(legacy));
    expect(registry.get(git.permissionAtom(env))).toBe(true);
    yield* git.authorize(registry, env);
  }),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);
