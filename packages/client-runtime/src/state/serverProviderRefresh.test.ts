import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProviderInstanceId,
  WS_METHODS,
  type AuthSessionState,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));

const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("refresh-environment"),
  label: "Refresh environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONFIG = {
  settings: {},
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as unknown as ServerConfig;

const makeRegistry = (client: WsRpcProtocolClient, config: ServerConfig) =>
  Effect.gen(function* () {
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed(config),
      subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
        Layer.succeed(Persistence.EnvironmentCacheStore, cache),
      ),
    );
    const atoms = createServerEnvironmentAtoms(runtime, {
      initialConfigValueAtom: () => Atom.make(config),
    });
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    registry.mount(sessions(TARGET.environmentId));
    registry.set(sessions(TARGET.environmentId), AsyncResult.success(grantedSession));
    return { atoms, registry };
  });

const grantedSession = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationReadScope],
  permissions: [AuthOrchestrationReadScope],
} satisfies AuthSessionState;

describe("provider refresh commands", () => {
  it.effect("sends a limits-only refresh as its own request", () =>
    Effect.gen(function* () {
      const requested = yield* Queue.unbounded<Record<string, unknown>>();
      const release = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.serverRefreshProviders]: (payload: Record<string, unknown>) =>
          Queue.offer(requested, payload).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ providers: [] }),
          ),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeRegistry(client, CONFIG);
      const full = atoms.refreshProviders.run(registry, {
        environmentId: TARGET.environmentId,
        input: {},
      });
      const limitsInput = { fresh: false, usageLimitsOnly: true };
      const limits = atoms.refreshProviders.run(registry, {
        environmentId: TARGET.environmentId,
        input: limitsInput,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => full);
      yield* Effect.promise(() => limits);
      // A limits-only refresh answers before the provider probe, so it cannot join the request
      // of a full refresh that is still running.
      expect(yield* Queue.takeAll(requested)).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("a limits-only reply keeps a fetched workspace snapshot", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("refresh-instance");
      const cwd = "/repo";
      const snapshot = (command: string) => ({
        cwd,
        checkedAt: "2026-11-12T00:00:00.000Z",
        slashCommands: [{ name: command }],
        skills: [],
      });
      const configProvider = {
        instanceId,
        enabled: true,
        slashCommands: [],
        skills: [],
        workspaceSnapshots: [snapshot("stale")],
      } as unknown as ServerConfig["providers"][number];
      const config = {
        settings: {},
        environment: {
          serverVersion: "0.0.1",
          capabilities: { providerWorkspaceSnapshotsOnDemand: true },
        },
        providers: [configProvider],
      } as unknown as ServerConfig;
      const client = {
        [WS_METHODS.serverRefreshProviders]: (payload: Record<string, unknown>) =>
          Effect.succeed(
            payload.usageLimitsOnly === true
              ? { providers: [] }
              : {
                  providers: [{ instanceId, workspaceSnapshots: [snapshot("fetched")] }],
                },
          ),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeRegistry(client, config);
      const readSnapshots = () =>
        registry.get(atoms.configValueAtom(TARGET.environmentId))?.providers[0]?.workspaceSnapshots;
      const full = atoms.refreshProviders.run(registry, {
        environmentId: TARGET.environmentId,
        input: { instanceId, cwd },
      });
      yield* Effect.promise(() => full);
      expect(readSnapshots()).toEqual([snapshot("fetched")]);
      const limits = atoms.refreshProviders.run(registry, {
        environmentId: TARGET.environmentId,
        input: { instanceId, cwd, fresh: false, usageLimitsOnly: true },
      });
      yield* Effect.promise(() => limits);
      // An empty limits-only reply must not retire the snapshot the full refresh fetched.
      expect(readSnapshots()).toEqual([snapshot("fetched")]);
    }).pipe(Effect.scoped),
  );
});
