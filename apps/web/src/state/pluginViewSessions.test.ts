import { describe, expect, it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentRpcSubscriptionObserver,
  type RpcSession,
  type WsRpcProtocolClient,
} from "@t3tools/client-runtime/rpc";
import {
  EnvironmentId,
  PluginInstallationId,
  type PluginView,
  PluginViewError,
  type PluginViewsSnapshot,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";

import { resolvePluginViewTarget, sessionEpoch } from "../panels/pluginView/pluginViewHost";
import {
  createSessionPluginViewsAtoms,
  currentSessionPluginViews,
  type SessionPluginViews,
  sidePanelPluginViews,
} from "./pluginViewSessions";

const environmentId = EnvironmentId.make("plugin-views-environment");
const TARGET = new PrimaryConnectionTarget({
  environmentId,
  label: "Plugin views environment",
  httpBaseUrl: "https://views.example.test",
  wsBaseUrl: "wss://views.example.test",
});

const board: PluginView = {
  installationId: PluginInstallationId.make("installation-1"),
  generation: 1,
  pluginId: "test.views-board",
  pluginName: "Board",
  viewId: "board",
  title: "Board",
  placement: "side-panel",
};
const surface = { installationId: "installation-1", viewId: "board" };
const snapshot = (views: ReadonlyArray<PluginView>): PluginViewsSnapshot => ({
  views: [...views],
  problems: [],
});

/** A session whose server answers `pluginViews.subscribe` with `views`, recording every call. */
function makeSession(
  capabilities: ServerConfig["environment"]["capabilities"],
  views: () => Stream.Stream<PluginViewsSnapshot, unknown>,
) {
  const calls: Array<string> = [];
  const client = new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        calls.push(method);
        return method === WS_METHODS.pluginViewsSubscribe ? views() : Effect.never;
      },
    },
  ) as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return { session, calls };
}

/** A session whose first snapshot is held until the test offers it. */
const makeHeldSession = Effect.fn("makeHeldSession")(function* () {
  const snapshots = yield* Queue.unbounded<PluginViewsSnapshot>();
  const subscribed = yield* Deferred.make<void>();
  const held = makeSession({ repositoryIdentity: true, pluginViews: true }, () =>
    Stream.unwrap(
      Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(snapshots))),
    ),
  );
  return { ...held, snapshots, subscribed };
});

/** The real session-bound views atom over a supervisor and registry the test drives. */
const makeHarness = Effect.fn("makeHarness")(function* (
  initial: RpcSession,
  observer = EnvironmentRpcSubscriptionObserver.defaultValue(),
) {
  const session = yield* SubscriptionRef.make(Option.some(initial));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, unknown>>(
    new Map([[environmentId, {}]]),
  );
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(EnvironmentRpcSubscriptionObserver, observer),
    ),
  );
  const atom = createSessionPluginViewsAtoms(runtime)(environmentId);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      registry.dispose();
    }),
  );
  const until = (predicate: (state: SessionPluginViews) => boolean) =>
    AtomRegistry.toStream(registry, atom).pipe(
      Stream.map(currentSessionPluginViews),
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return { session, entries, until };
});

/** What the host does with a state: the panel's target and the launcher rows. */
const host = (state: SessionPluginViews) => ({
  target: resolvePluginViewTarget({
    views: state.views,
    surface,
    session: sessionEpoch(state.session),
  }),
  launcher: sidePanelPluginViews(state.views).map((view) => view.viewId),
});

const subscriptionEndings: ReadonlyArray<{
  readonly ending: string;
  readonly endStream: Stream.Stream<never, unknown>;
}> = [
  {
    ending: "loses its transport",
    endStream: Stream.fail(
      new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "socket closed",
          cause: new Error("socket closed"),
        }),
      }),
    ),
  },
  {
    ending: "fails on the server",
    endStream: Stream.fail(new PluginViewError({ reason: "busy", message: "busy" })),
  },
  { ending: "completes", endStream: Stream.empty },
];

describe("session-bound plugin views", () => {
  it.effect.each(subscriptionEndings)(
    "withdraws views while the session stays when its subscription $ending",
    ({ endStream }) =>
      Effect.gen(function* () {
        const end = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const a = makeSession({ repositoryIdentity: true, pluginViews: true }, () =>
          Stream.succeed(snapshot([board])).pipe(
            Stream.concat(Stream.unwrap(Deferred.await(end).pipe(Effect.as(endStream)))),
          ),
        );
        const harness = yield* makeHarness(a.session, {
          observe: () => Effect.succeed(Deferred.succeed(finalized, undefined).pipe(Effect.asVoid)),
        });
        const available = host(yield* harness.until((state) => state.views !== null));
        expect(available.target._tag).toBe("mount");
        expect(available.launcher).toEqual(["board"]);

        yield* Deferred.succeed(end, undefined);
        yield* Deferred.await(finalized);
        // The supervisor still publishes `a`; only its views stream ended.
        const lost = yield* harness.until((state) => state.views === null);
        expect(lost.session).toBe(a.session);
        expect(host(lost)).toEqual({ target: { _tag: "waiting" }, launcher: [] });
        expect(a.calls).toEqual([WS_METHODS.pluginViewsSubscribe]);

        const b = yield* makeHeldSession();
        yield* SubscriptionRef.set(harness.session, Option.some(b.session));
        yield* Deferred.await(b.subscribed);
        expect(host(yield* harness.until((state) => state.session === b.session))).toEqual({
          target: { _tag: "waiting" },
          launcher: [],
        });
        yield* Queue.offer(b.snapshots, snapshot([board]));
        const restored = host(
          yield* harness.until((state) => state.session === b.session && state.views !== null),
        );
        expect(restored.launcher).toEqual(["board"]);
        expect(restored.target._tag).toBe("mount");
        if (available.target._tag === "mount" && restored.target._tag === "mount")
          expect(restored.target.key).not.toBe(available.target.key);
      }),
  );

  it.effect("never lets a previous session's views mount or list a view in the next one", () =>
    Effect.gen(function* () {
      const a = makeSession({ repositoryIdentity: true, pluginViews: true }, () =>
        Stream.succeed(snapshot([board])).pipe(Stream.concat(Stream.never)),
      );
      const harness = yield* makeHarness(a.session);
      const availableA = host(yield* harness.until((state) => state.views !== null));
      expect(availableA.target._tag).toBe("mount");
      expect(availableA.launcher).toEqual(["board"]);

      yield* SubscriptionRef.set(harness.session, Option.none());
      const disconnected = host(yield* harness.until((state) => state.session === null));
      expect(disconnected).toEqual({ target: { _tag: "waiting" }, launcher: [] });

      const b = yield* makeHeldSession();
      yield* SubscriptionRef.set(harness.session, Option.some(b.session));
      yield* Deferred.await(b.subscribed);
      const held = yield* harness.until((state) => state.session === b.session);
      expect(held.views).toBeNull();
      expect(host(held)).toEqual({ target: { _tag: "waiting" }, launcher: [] });

      yield* Queue.offer(b.snapshots, snapshot([]));
      const emptyB = host(yield* harness.until((state) => state.views !== null));
      expect(emptyB).toEqual({ target: { _tag: "unavailable", problem: null }, launcher: [] });
    }),
  );

  it.effect("mounts a view the new session approves only after its own snapshot", () =>
    Effect.gen(function* () {
      const a = makeSession({ repositoryIdentity: true, pluginViews: true }, () =>
        Stream.succeed(snapshot([board])).pipe(Stream.concat(Stream.never)),
      );
      const harness = yield* makeHarness(a.session);
      const mountA = host(yield* harness.until((state) => state.views !== null)).target;

      const b = yield* makeHeldSession();
      // A direct replacement, with no disconnected state in between.
      yield* SubscriptionRef.set(harness.session, Option.some(b.session));
      yield* Deferred.await(b.subscribed);
      expect(host(yield* harness.until((state) => state.session === b.session))).toEqual({
        target: { _tag: "waiting" },
        launcher: [],
      });

      yield* Queue.offer(b.snapshots, snapshot([board]));
      const approved = host(
        yield* harness.until((state) => state.session === b.session && state.views !== null),
      );
      expect(approved.launcher).toEqual(["board"]);
      expect(approved.target._tag).toBe("mount");
      expect(mountA._tag === "mount" && approved.target._tag === "mount").toBe(true);
      if (mountA._tag === "mount" && approved.target._tag === "mount")
        expect(approved.target.key).not.toBe(mountA.key);
    }),
  );

  it.effect("sends nothing to a server without views and forgets a removed environment", () =>
    Effect.gen(function* () {
      const old = makeSession({ repositoryIdentity: true, plugins: true }, () => Stream.never);
      const harness = yield* makeHarness(old.session);
      const unsupported = yield* harness.until((state) => state.views !== null);
      expect(host(unsupported)).toEqual({ target: { _tag: "unsupported" }, launcher: [] });
      expect(old.calls).toEqual([]);

      const a = makeSession({ repositoryIdentity: true, pluginViews: true }, () =>
        Stream.succeed(snapshot([board])).pipe(Stream.concat(Stream.never)),
      );
      yield* SubscriptionRef.set(harness.session, Option.some(a.session));
      yield* harness.until((state) => state.session === a.session && state.views !== null);
      yield* SubscriptionRef.set(harness.entries, new Map());
      const removed = yield* harness.until((state) => state.session === null);
      expect(host(removed)).toEqual({ target: { _tag: "waiting" }, launcher: [] });
    }),
  );
});
