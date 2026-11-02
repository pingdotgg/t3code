import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  WS_METHODS,
  type ProviderAuthState,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
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

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("auth-environment"),
  label: "Auth environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const instanceId = ProviderInstanceId.make("codex_cli_second");
const config = {
  providers: [],
  settings: DEFAULT_SERVER_SETTINGS,
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as unknown as ServerConfig;
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.156.1",
  status: "ready",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-17T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};
const idle: ProviderAuthState = {
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};

it.effect("waits for a newly configured provider and preserves its active auth subscription", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
    const auth = yield* SubscriptionRef.make(idle);
    const closed = yield* Queue.unbounded<void>();
    let registered = false;
    let requests = 0;
    const client = {
      [WS_METHODS.subscribeServerConfig]: () =>
        Stream.concat(
          Stream.succeed({ version: 1 as const, type: "snapshot" as const, config }),
          Stream.fromQueue(events),
        ),
      [WS_METHODS.providerAuthSubscribe]: () =>
        Stream.unwrap(
          Effect.sync(() => {
            requests++;
            return registered
              ? SubscriptionRef.changes(auth).pipe(Stream.ensuring(Queue.offer(closed, undefined)))
              : Stream.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "subscribe",
                    detail: "This provider instance is no longer available.",
                  }),
                );
          }),
        ),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed(config),
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
      setDiscoveredRoutes: () => Effect.void,
    });
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
        Layer.mock(Persistence.EnvironmentCacheStore)({
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
        }),
      ),
    );
    const initialConfigValueAtom = Atom.make(config);
    const atoms = createServerEnvironmentAtoms(runtime, {
      initialConfigValueAtom: () => initialConfigValueAtom,
    });
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
      Effect.sync(() => value.dispose()),
    );
    const authAtom = atoms.providerAuthState({
      environmentId: target.environmentId,
      input: { instanceId },
    });
    const observed = yield* Queue.unbounded<AsyncResult.AsyncResult<ProviderAuthState, unknown>>();
    yield* AtomRegistry.toStream(registry, authAtom).pipe(
      Stream.runForEach((value) => Queue.offer(observed, value)),
      Effect.forkScoped,
    );
    expect(AsyncResult.isInitial(registry.get(authAtom))).toBe(true);

    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: provider.driver, config: { setupMode: "cli" } },
      },
    };
    yield* Queue.offer(events, { version: 1, type: "settingsUpdated", payload: { settings } });
    yield* AtomRegistry.toStream(registry, atoms.settingsValueAtom(target.environmentId)).pipe(
      Stream.filter(
        (value) => value !== null && Object.hasOwn(value.providerInstances, instanceId),
      ),
      Stream.runHead,
    );
    expect(requests).toBe(0);
    expect(AsyncResult.isInitial(registry.get(authAtom))).toBe(true);

    registered = true;
    yield* Queue.offer(events, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [provider] },
    });
    const nextSuccess = Stream.fromQueue(observed).pipe(
      Stream.filter(AsyncResult.isSuccess),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    expect((yield* nextSuccess).value).toEqual(idle);
    expect(requests).toBe(1);

    const waiting: ProviderAuthState = {
      ...idle,
      phase: "waiting",
      flowId: "native-login",
      authorizationUrl: "https://auth.openai.com/device",
    };
    yield* SubscriptionRef.set(auth, waiting);
    expect((yield* nextSuccess).value).toEqual(waiting);
    const updated = { ...provider, displayName: "Second account" };
    yield* Queue.offer(events, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [updated] },
    });
    yield* AtomRegistry.toStream(registry, atoms.providersValueAtom(target.environmentId)).pipe(
      Stream.filter((value) => value?.[0]?.displayName === updated.displayName),
      Stream.runHead,
    );
    expect(requests).toBe(1);
    expect(registry.get(authAtom)).toMatchObject({ _tag: "Success", value: waiting });

    const succeeded: ProviderAuthState = { ...idle, phase: "succeeded", flowId: waiting.flowId };
    yield* SubscriptionRef.set(auth, succeeded);
    expect((yield* nextSuccess).value).toEqual(succeeded);

    registered = false;
    yield* Queue.offer(events, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    });
    yield* Queue.take(closed);
    expect(AsyncResult.isInitial(registry.get(authAtom))).toBe(true);
    registered = true;
    yield* SubscriptionRef.set(auth, idle);
    yield* Queue.offer(events, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [provider] },
    });
    expect((yield* nextSuccess).value).toEqual(idle);
    expect(requests).toBe(2);

    registered = false;
    yield* Queue.offer(events, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    });
    yield* Queue.take(closed);
    expect(AsyncResult.isInitial(registry.get(authAtom))).toBe(true);
    yield* Queue.offer(events, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: DEFAULT_SERVER_SETTINGS },
    });
    yield* AtomRegistry.toStream(registry, atoms.settingsValueAtom(target.environmentId)).pipe(
      Stream.filter(
        (value) => value !== null && !Object.hasOwn(value.providerInstances, instanceId),
      ),
      Stream.runHead,
    );
    const deleted = registry.get(authAtom);
    expect(AsyncResult.isFailure(deleted)).toBe(true);
    if (AsyncResult.isFailure(deleted)) {
      expect(Cause.squash(deleted.cause)).toMatchObject({
        _tag: "ProviderSetupError",
        instanceId,
        operation: "subscribe",
        detail: "This provider instance is no longer available.",
      });
    }

    yield* Queue.offer(events, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });
    yield* AtomRegistry.toStream(registry, atoms.settingsValueAtom(target.environmentId)).pipe(
      Stream.filter(
        (value) => value !== null && Object.hasOwn(value.providerInstances, instanceId),
      ),
      Stream.runHead,
    );
    registered = true;
    yield* Queue.offer(events, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [provider] },
    });
    expect((yield* nextSuccess).value).toEqual(idle);
    expect(requests).toBe(3);

    yield* Queue.offer(events, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: DEFAULT_SERVER_SETTINGS },
    });
    yield* AtomRegistry.toStream(registry, atoms.settingsValueAtom(target.environmentId)).pipe(
      Stream.filter(
        (value) => value !== null && !Object.hasOwn(value.providerInstances, instanceId),
      ),
      Stream.runHead,
    );
    expect(registry.get(authAtom)).toMatchObject({ _tag: "Success", value: idle });
    registered = false;
    yield* Queue.offer(events, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    });
    yield* Queue.take(closed);
    const deletedAfterStatusRemoval = registry.get(authAtom);
    expect(AsyncResult.isFailure(deletedAfterStatusRemoval)).toBe(true);
    if (AsyncResult.isFailure(deletedAfterStatusRemoval)) {
      expect(Cause.squash(deletedAfterStatusRemoval.cause)).toMatchObject({
        _tag: "ProviderSetupError",
        instanceId,
        operation: "subscribe",
        detail: "This provider instance is no longer available.",
      });
    }
  }),
);
