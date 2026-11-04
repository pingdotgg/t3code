import {
  EnvironmentId,
  PluginInstallationId,
  type ServerConfig,
  type PluginViewsSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  callPluginView,
  readPluginViewBundle,
  pluginViewsStream,
  type PluginViewsView,
} from "./pluginViews.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const installationId = PluginInstallationId.make("installation-1");

/** A supervisor whose one session talks to a server reporting `capabilities`, recording calls. */
const withServer = Effect.fn("withServer")(function* (
  capabilities: ServerConfig["environment"]["capabilities"],
) {
  const calls: Array<string> = [];
  const client = new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        calls.push(method);
        return Effect.succeed({ value: null });
      },
    },
  ) as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    inboundFrames: Effect.succeed(0),
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
  const run = <A, E>(
    effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
  ): Effect.Effect<A, E> =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  return { calls, run, supervisor, session };
});

const target = { installationId, generation: 1, viewId: "board" };

it.effect(
  "never subscribes a replacement session using the previous server's view capability",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { supervisor, session } = yield* withServer({
          repositoryIdentity: true,
          pluginViews: true,
        });
        const calls: Array<string> = [];
        const checkedCalls: Array<string> = [];
        const snapshot: PluginViewsSnapshot = {
          views: [],
          problems: [{ installationId, generation: 1, message: "Checked session" }],
        };
        const subscribing = (received: Array<string>): RpcSession.RpcSession => ({
          ...session,
          client: {
            [WS_METHODS.pluginViewsSubscribe]: () => {
              received.push(WS_METHODS.pluginViewsSubscribe);
              return Stream.succeed(snapshot).pipe(Stream.concat(Stream.never));
            },
          } as unknown as WsRpcProtocolClient,
        });
        yield* SubscriptionRef.set(supervisor.session, Option.some(subscribing(checkedCalls)));
        const replacementRef = yield* SubscriptionRef.make(
          Option.some({
            ...subscribing(calls),
            initialConfig: Effect.succeed({
              environment: { capabilities: { repositoryIdentity: true } },
            } as ServerConfig),
          }),
        );
        let reads = 0;
        // Deliver the captured session to the outer stream, then expose the replacement
        // to an independent current-session read in the production RPC subscriber.
        const racingSupervisor = {
          ...supervisor,
          get session() {
            return reads++ === 0 ? supervisor.session : replacementRef;
          },
        };
        const view = yield* pluginViewsStream.pipe(
          Stream.filter((view) => view._tag === "available" && view.problems.length > 0),
          Stream.runHead,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, racingSupervisor),
        );
        expect(Option.getOrThrow(view)).toEqual({ _tag: "available", ...snapshot });
        expect(checkedCalls).toEqual([WS_METHODS.pluginViewsSubscribe]);
        expect(calls).toEqual([]);
      }),
    ),
);

it.effect("rechecks view capabilities and subscribes again after a disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run, supervisor, session } = yield* withServer({
        repositoryIdentity: true,
        pluginViews: true,
      });
      const calls: Array<number> = [];
      const snapshot: PluginViewsSnapshot = {
        views: [],
        problems: [{ installationId, generation: 1, message: "View problem" }],
      };
      const capable = (generation: number): RpcSession.RpcSession => ({
        ...session,
        client: {
          [WS_METHODS.pluginViewsSubscribe]: () => {
            calls.push(generation);
            return Stream.succeed(snapshot).pipe(Stream.concat(Stream.never));
          },
        } as unknown as WsRpcProtocolClient,
      });
      yield* SubscriptionRef.set(supervisor.session, Option.some(capable(1)));
      const frames = yield* Queue.unbounded<PluginViewsView>();
      yield* run(
        pluginViewsStream.pipe(Stream.runForEach((view) => Queue.offer(frames, view))),
      ).pipe(Effect.forkScoped);
      const empty = { _tag: "available", views: [], problems: [] };
      expect(yield* Queue.take(frames)).toEqual(empty);
      expect(yield* Queue.take(frames)).toEqual({ _tag: "available", ...snapshot });
      const older = yield* withServer({ repositoryIdentity: true });
      yield* SubscriptionRef.set(supervisor.session, Option.some(older.session));
      expect(yield* Queue.take(frames)).toEqual(empty);
      expect(yield* Queue.take(frames)).toEqual({ _tag: "unsupported" });
      expect(older.calls).toEqual([]);
      yield* SubscriptionRef.set(supervisor.session, Option.none());
      expect(yield* Queue.take(frames)).toEqual(empty);
      yield* SubscriptionRef.set(supervisor.session, Option.some(capable(2)));
      expect(yield* Queue.take(frames)).toEqual(empty);
      expect(yield* Queue.take(frames)).toEqual({ _tag: "available", ...snapshot });
      expect(calls).toEqual([1, 2]);
      expect(older.calls).toEqual([]);
    }),
  ),
);

describe("plugin views on servers with and without them", () => {
  it.effect("loads nothing and calls nothing on a server without views", () =>
    Effect.gen(function* () {
      for (const capabilities of [
        { repositoryIdentity: true, plugins: true },
        { repositoryIdentity: true, plugins: true, pluginViews: false },
      ]) {
        const { calls, run } = yield* withServer(capabilities);
        const bundle = yield* run(readPluginViewBundle(target)).pipe(Effect.flip);
        expect(bundle._tag).toBe("EnvironmentRpcUnavailableError");
        const called = yield* run(
          callPluginView({ ...target, handler: "stats", input: null }),
        ).pipe(Effect.flip);
        expect(called._tag).toBe("EnvironmentRpcUnavailableError");
        expect(calls).toEqual([]);
      }
    }),
  );

  it.effect("loads and calls on a server that announces views", () =>
    Effect.gen(function* () {
      const { calls, run } = yield* withServer({ repositoryIdentity: true, pluginViews: true });
      yield* run(readPluginViewBundle(target));
      yield* run(callPluginView({ ...target, handler: "stats", input: null }));
      expect(calls).toEqual([WS_METHODS.pluginViewsReadBundle, WS_METHODS.pluginViewsCall]);
    }),
  );
});

it.effect.each([
  { disconnect: false, waiting: "config" },
  { disconnect: true, waiting: "config" },
  { disconnect: false, waiting: "snapshot" },
  { disconnect: true, waiting: "snapshot" },
])(
  "clears old views while waiting for $waiting (disconnect=$disconnect)",
  ({ disconnect, waiting }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { run, supervisor, session } = yield* withServer({
          repositoryIdentity: true,
          pluginViews: true,
        });
        const snapshot: PluginViewsSnapshot = {
          views: [
            {
              installationId,
              generation: 1,
              viewId: "board",
              pluginId: "test.old",
              pluginName: "Old plugin",
              title: "Old board",
              placement: "side-panel",
            },
          ],
          problems: [{ installationId, generation: 1, message: "Old problem" }],
        };
        const first = yield* Deferred.make<void>();
        const configuring = yield* Deferred.make<void>();
        const disconnected = yield* Deferred.make<void>();
        const replaced = yield* Deferred.make<void>();
        let phase = "initial";
        const frames: Array<PluginViewsView> = [];
        const capable = {
          ...session,
          client: {
            [WS_METHODS.pluginViewsSubscribe]: () =>
              Stream.succeed(snapshot).pipe(Stream.concat(Stream.never)),
          } as unknown as WsRpcProtocolClient,
        };
        yield* SubscriptionRef.set(supervisor.session, Option.some(capable));
        yield* run(
          pluginViewsStream.pipe(
            Stream.runForEach((frame) =>
              Effect.gen(function* () {
                frames.push(frame);
                if (frame._tag === "available" && frame.views.length > 0)
                  yield* Deferred.succeed(first, undefined);
                else if (phase === "disconnect") yield* Deferred.succeed(disconnected, undefined);
                else if (phase === "replacement") yield* Deferred.succeed(replaced, undefined);
              }),
            ),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(first);
        expect(frames[0]).toEqual({ _tag: "available", views: [], problems: [] });
        if (disconnect) {
          phase = "disconnect";
          yield* SubscriptionRef.set(supervisor.session, Option.none());
          yield* Deferred.await(disconnected);
        }
        phase = "replacement";
        yield* SubscriptionRef.set(
          supervisor.session,
          Option.some({
            ...session,
            initialConfig:
              waiting === "config"
                ? Deferred.succeed(configuring, undefined).pipe(Effect.andThen(Effect.never))
                : session.initialConfig,
            client: {
              [WS_METHODS.pluginViewsSubscribe]: () =>
                Stream.fromEffect(Deferred.succeed(configuring, undefined)).pipe(
                  Stream.flatMap(() => Stream.never),
                ),
            } as unknown as WsRpcProtocolClient,
          }),
        );
        yield* Deferred.await(configuring);
        yield* Deferred.await(replaced);
        const empty = { _tag: "available", views: [], problems: [] };
        expect(frames).toEqual([
          empty,
          { _tag: "available", ...snapshot },
          ...(disconnect ? [empty] : []),
          empty,
        ]);
      }),
    ),
);
