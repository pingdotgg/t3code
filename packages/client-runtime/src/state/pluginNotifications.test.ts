import {
  EnvironmentId,
  type PluginNotificationFrame,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createPluginNotificationEnvironmentAtoms,
  type PluginNotificationMark,
  pluginNotificationChanges,
  pluginNotificationDescription,
} from "./pluginNotifications.ts";

const notification = (sequence: number) => ({
  sequence,
  pluginId: "acme.ci",
  pluginName: "CI watcher",
  title: `n${sequence}`,
  ...(sequence === 2 ? { body: "Two failed" } : {}),
  createdAt: "2026-10-04T00:00:00.000Z",
});

const frame = (epoch: string, sequences: ReadonlyArray<number>): PluginNotificationFrame => ({
  epoch,
  notifications: sequences.map(notification),
});

const config = (supported: boolean) =>
  ({
    environment: {
      serverVersion: "0.0.1",
      capabilities: supported ? { pluginNotifications: true } : {},
    },
  }) as ServerConfig;

/** A session whose server pushes frames from a queue and counts the subscriptions it receives. */
const makeSession = Effect.fn("makeSession")(function* (
  serverConfig: "supported" | "old" | "unknown",
) {
  const frames = yield* Queue.unbounded<PluginNotificationFrame>();
  const calls: Array<unknown> = [];
  // Completes when the client asks this session for its config, before deciding to subscribe.
  const configRead = yield* Deferred.make<void>();
  const client = {
    [WS_METHODS.pluginsNotificationsSubscribe]: (input: unknown) => {
      calls.push(input);
      return Stream.fromQueue(frames);
    },
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.andThen(
      Deferred.succeed(configRead, undefined),
      serverConfig === "unknown"
        ? Effect.never
        : Effect.succeed(config(serverConfig === "supported")),
    ),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return {
    session,
    calls,
    configRead,
    push: (next: PluginNotificationFrame) => Queue.offer(frames, next),
  };
});

/**
 * One environment over a replaceable session. `cachedSupported` is the
 * client's cached config, which can disagree with the session's server.
 */
const makeHarness = Effect.fn("makeHarness")(function* (cachedSupported: boolean) {
  const environmentId = EnvironmentId.make("env-a");
  const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "env-a",
      httpBaseUrl: "https://env-a.example.test",
      wsBaseUrl: "wss://env-a.example.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const atoms = createPluginNotificationEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService)),
    { configValueAtom: () => Atom.make(config(cachedSupported)) },
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const unmount = registry.mount(atoms.frame(environmentId));
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  return {
    /** Swaps in a new connection, as a reconnect does. */
    connect: Effect.fn("connect")(function* (serverConfig: "supported" | "old" | "unknown") {
      const next = yield* makeSession(serverConfig);
      yield* SubscriptionRef.set(session, Option.some(next.session));
      return next;
    }),
    /** Waits until the frame matches, the client-side receipt for a server frame. */
    waitFor: (done: (current: PluginNotificationFrame | null) => boolean) =>
      AtomRegistry.toStream(registry, atoms.frame(environmentId)).pipe(
        Stream.filter(done),
        Stream.runHead,
      ),
    current: () => registry.get(atoms.frame(environmentId)),
  };
});

const sequences = (current: PluginNotificationFrame | null) =>
  current?.notifications.map((each) => each.sequence).join() ?? "null";

describe("plugin notification subscription", () => {
  it.effect("subscribes on each supporting session and keeps the last frame meanwhile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(true);
        const first = yield* harness.connect("supported");
        yield* first.push(frame("e1", [1]));
        yield* harness.waitFor((current) => sequences(current) === "1");

        const second = yield* harness.connect("supported");
        // Still the last frame until the new session sends the current set.
        assert.strictEqual(sequences(harness.current()), "1");
        yield* second.push(frame("e1", [1, 2]));
        yield* harness.waitFor((current) => sequences(current) === "1,2");
        assert.deepStrictEqual([first.calls, second.calls], [[{}], [{}]]);
      }),
    ),
  );

  it.effect("never calls a session whose own server lacks the capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The cached config still says the environment supports notifications.
        const harness = yield* makeHarness(true);
        const supporting = yield* harness.connect("supported");
        yield* supporting.push(frame("e1", [1]));
        yield* harness.waitFor((current) => sequences(current) === "1");

        const old = yield* harness.connect("old");
        yield* harness.waitFor((current) => current === null);
        assert.deepStrictEqual(old.calls, []);

        // A session that never delivers its config is not called either.
        const unknown = yield* harness.connect("unknown");
        yield* Deferred.await(unknown.configRead);
        const after = yield* harness.connect("supported");
        yield* after.push(frame("e1", [1]));
        yield* harness.waitFor((current) => sequences(current) === "1");
        assert.deepStrictEqual(unknown.calls, []);
      }),
    ),
  );

  it.effect("subscribes nowhere when the cached config lacks the capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(false);
        const session = yield* harness.connect("supported");
        yield* session.push(frame("e1", [1]));
        assert.deepStrictEqual(session.calls, []);
        assert.isNull(harness.current());
      }),
    ),
  );
});

/**
 * A renderer reduced to what it keeps: the mark and its visible toasts by
 * key, with nothing dismissed on a timer, so `visible` is the worst case.
 */
const renderer = () => {
  let mark: PluginNotificationMark | undefined;
  const visible = new Map<string, string>();
  return {
    visible,
    get mark() {
      return mark;
    },
    apply(next: PluginNotificationFrame | null) {
      const changes = pluginNotificationChanges(mark, next);
      mark = changes.mark;
      const closed: Array<string> = [];
      for (const [key, title] of visible)
        if (!changes.keep.has(key)) {
          visible.delete(key);
          closed.push(title);
        }
      for (const entry of changes.show) visible.set(entry.key, entry.notification.title);
      return { shown: changes.show.map((entry) => entry.notification.title), closed };
    },
  };
};

describe("pluginNotificationChanges", () => {
  it("shows nothing old on launch and each later notification once", () => {
    const client = renderer();
    assert.deepStrictEqual(client.apply(null), { shown: [], closed: [] });
    assert.deepStrictEqual(client.apply(frame("e1", [1, 2])), { shown: [], closed: [] });
    assert.deepStrictEqual(client.apply(frame("e1", [1, 2, 3])), { shown: ["n3"], closed: [] });
    assert.deepStrictEqual(client.apply(frame("e1", [1, 2, 3])), { shown: [], closed: [] });
  });

  it("shows only what a reconnect missed and closes what was withdrawn meanwhile", () => {
    // Two clients see n1; one stays connected, the other is away while n2
    // arrives and n1's plugin is disabled.
    const connected = renderer();
    const away = renderer();
    for (const client of [connected, away]) {
      client.apply(frame("e1", []));
      assert.deepStrictEqual(client.apply(frame("e1", [1])).shown, ["n1"]);
    }
    assert.deepStrictEqual(connected.apply(frame("e1", [1, 2])).shown, ["n2"]);
    assert.deepStrictEqual(connected.apply(frame("e1", [2])), { shown: [], closed: ["n1"] });

    // The reconnect's first frame is the current set: n2 is new, n1 is gone.
    assert.deepStrictEqual(away.apply(frame("e1", [2])), { shown: ["n2"], closed: ["n1"] });
    assert.deepStrictEqual(away.apply(frame("e1", [2])), { shown: [], closed: [] });
  });

  it("closes the oldest toast when newer notifications evict it", () => {
    const client = renderer();
    client.apply(frame("e1", []));
    const sent: Array<number> = [];
    for (let sequence = 1; sequence <= 20; sequence++) {
      sent.push(sequence);
      client.apply(frame("e1", sent));
    }
    assert.isTrue(client.visible.has('["e1",1]'));
    assert.deepStrictEqual(client.apply(frame("e1", sent.slice(1).concat(21))), {
      shown: ["n21"],
      closed: ["n1"],
    });
    // Expiry is the same: the frame without them closes them.
    assert.strictEqual(client.apply(frame("e1", [])).closed.length, 20);
  });

  it("closes the previous run's toasts after a restart and shows the new run's", () => {
    const client = renderer();
    client.apply(frame("e1", []));
    client.apply(frame("e1", [7]));
    assert.deepStrictEqual(client.apply(frame("e2", [1])), { shown: ["n1"], closed: ["n7"] });

    // An older server or a lost capability closes everything but keeps the mark.
    assert.deepStrictEqual(client.apply(null), { shown: [], closed: ["n1"] });
    assert.deepStrictEqual(client.apply(frame("e2", [1, 2])).shown, ["n2"]);
  });

  it("keeps bounded state however many notifications arrive", () => {
    const client = renderer();
    client.apply(frame("e1", []));
    let shown = 0;
    for (let sequence = 1; sequence <= 10_000; sequence++) {
      const retained = Array.from(
        { length: Math.min(20, sequence) },
        (_, index) => sequence - index,
      ).toReversed();
      shown += client.apply(frame("e1", retained)).shown.length;
      // Reconnects resend the same set and repeat nothing.
      if (sequence % 1_000 === 0) shown += client.apply(frame("e1", retained)).shown.length;
    }
    assert.strictEqual(shown, 10_000);
    assert.strictEqual(client.visible.size, 20);
    assert.deepStrictEqual(client.mark, { epoch: "e1", sequence: 10_000 });
  });

  it("names the plugin beside the body", () => {
    const { show } = pluginNotificationChanges({ epoch: "e1", sequence: 0 }, frame("e1", [1, 2]));
    assert.deepStrictEqual(show.map(pluginNotificationDescription), [
      "From CI watcher",
      "Two failed · CI watcher",
    ]);
  });
});
