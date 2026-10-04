import {
  EnvironmentId,
  PluginInstallationId,
  type PluginCatalogSnapshot,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createPluginEnvironmentAtoms, pluginCatalogStream } from "./plugins.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const SNAPSHOT: PluginCatalogSnapshot = {
  installations: [
    {
      installationId: PluginInstallationId.make("installation-1"),
      generation: 0,
      directory: "/srv/plugins/notifier",
      manifest: null,
      source: null,
      problem: "the directory does not exist.",
      inspectedAt: "2026-10-04T00:00:00.000Z",
      consent: null,
      enabled: false,
      addedAt: "2026-10-04T00:00:00.000Z",
    },
  ],
};

/** Runs the catalogue stream against one session whose server reports `capabilities`. */
const firstView = Effect.fn("firstView")(function* (
  capabilities: ServerConfig["environment"]["capabilities"],
) {
  const calls: Array<string> = [];
  const client = new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        calls.push(method);
        return method === WS_METHODS.pluginsSubscribe
          ? Stream.succeed(SNAPSHOT).pipe(Stream.concat(Stream.never))
          : Stream.never;
      },
    },
  ) as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const view = yield* pluginCatalogStream.pipe(
    Stream.runHead,
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  );
  return { view: Option.getOrThrow(view), calls };
});

describe("pluginCatalogStream", () => {
  it.effect("never calls a server that does not announce the plugin catalogue", () =>
    Effect.gen(function* () {
      const { view, calls } = yield* firstView({ repositoryIdentity: true });
      expect(view).toEqual({ _tag: "unsupported" });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("subscribes on a server that announces it", () =>
    Effect.gen(function* () {
      const { view, calls } = yield* firstView({ repositoryIdentity: true, plugins: true });
      expect(view).toEqual({
        _tag: "available",
        installations: SNAPSHOT.installations,
        revision: expect.any(Number),
      });
      expect(calls).toEqual([WS_METHODS.pluginsSubscribe]);
    }),
  );
});

/** A session to a server reporting `capabilities` that records each call it receives. */
const recordingSession = (
  capabilities: ServerConfig["environment"]["capabilities"],
  calls: Array<string>,
  answer: Effect.Effect<unknown> = Effect.succeed({ installations: [] }),
): RpcSession.RpcSession => ({
  client: new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        calls.push(method);
        return answer;
      },
    },
  ) as WsRpcProtocolClient,
  initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
  subscribeServerConfig: () => Stream.never,
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
});

/** The plugin commands of one environment whose current session is `session`. */
const makeCommands = Effect.fn("makeCommands")(function* (session: RpcSession.RpcSession) {
  const sessionRef = yield* SubscriptionRef.make(Option.some(session));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: sessionRef,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const atoms = createPluginEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const environmentId = TARGET.environmentId;
  const installationId = PluginInstallationId.make("installation-1");
  const runAll: ReadonlyArray<() => Promise<AsyncResult.AsyncResult<unknown, unknown>>> = [
    () => atoms.add.run(registry, { environmentId, input: { directory: "/srv/plugin" } }),
    () => atoms.refresh.run(registry, { environmentId, input: {} }),
    () =>
      atoms.consent.run(registry, {
        environmentId,
        input: { installationId, digest: `sha256:${"0".repeat(64)}` },
      }),
    () => atoms.enable.run(registry, { environmentId, input: { installationId } }),
    () => atoms.disable.run(registry, { environmentId, input: { installationId } }),
    () => atoms.remove.run(registry, { environmentId, input: { installationId } }),
    () => atoms.resume.run(registry, { environmentId, input: { installationId } }),
  ];
  return { atoms, registry, sessionRef, runAll, environmentId, installationId };
});

const failureTag = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result)
    ? Option.getOrUndefined(Cause.findErrorOption(result.cause) as Option.Option<{ _tag: string }>)
        ?._tag
    : undefined;

describe("plugin commands", () => {
  it.effect("send nothing to a server without the plugin catalogue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const capabilities of [
          { repositoryIdentity: true },
          { repositoryIdentity: true, plugins: false },
        ]) {
          const calls: Array<string> = [];
          const { runAll } = yield* makeCommands(recordingSession(capabilities, calls));
          for (const run of runAll) {
            const result = yield* Effect.promise(run);
            expect(failureTag(result)).toBe("EnvironmentRpcUnavailableError");
          }
          expect(calls).toEqual([]);
        }
      }),
    ),
  );

  it.effect("check the session a queued command runs on, not the one it was queued on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const newCalls: Array<string> = [];
        const reached = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const newServer = recordingSession(
          { repositoryIdentity: true, plugins: true },
          newCalls,
          Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(held)),
            Effect.as({ installations: [] }),
          ),
        );
        const { atoms, registry, sessionRef, environmentId, installationId } =
          yield* makeCommands(newServer);

        // The first command holds the queue; the second waits behind it.
        const first = yield* Effect.promise(() =>
          atoms.refresh.run(registry, { environmentId, input: {} }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const queued = yield* Effect.promise(() =>
          atoms.disable.run(registry, { environmentId, input: { installationId } }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(reached);

        // The environment reconnects to an older server before the queue moves on.
        const oldCalls: Array<string> = [];
        yield* SubscriptionRef.set(
          sessionRef,
          Option.some(recordingSession({ repositoryIdentity: true }, oldCalls)),
        );
        yield* Deferred.succeed(held, undefined);
        expect(AsyncResult.isSuccess(yield* Fiber.join(first))).toBe(true);
        expect(failureTag(yield* Fiber.join(queued))).toBe("EnvironmentRpcUnavailableError");
        expect(oldCalls).toEqual([]);
        expect(newCalls).toEqual([WS_METHODS.pluginsRefresh]);
      }),
    ),
  );
});
