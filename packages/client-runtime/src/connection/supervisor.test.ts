import { EnvironmentId } from "@t3tools/contracts";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
});

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
};

const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: RELAY_TARGET,
  profile: Option.none(),
};

const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const TEST_RPC_CLIENT = {} as WsRpcProtocolClient;

function transient(message = "Connection failed.") {
  return new ConnectionTransientError({
    reason: "transport",
    detail: message,
  });
}

function blocked(message = "Authentication required.") {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: message,
  });
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const eventuallyState = Effect.fn("TestConnectionHarness.eventuallyState")(function* (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  let lastState = yield* SubscriptionRef.get(state);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    lastState = yield* SubscriptionRef.get(state);
    if (predicate(lastState)) {
      return lastState;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(
    new Error(
      `Expected supervisor state was not observed. Last state: phase=${lastState.phase}, stage=${lastState.stage ?? "none"}, attempt=${lastState.attempt}, generation=${lastState.generation}`,
    ),
  );
});

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (
    attempt: number,
    target: ConnectionTarget,
  ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({
    sequence: 0,
    reason: "application-active",
  });
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });

  const prepare = Effect.fn("TestConnectionDriver.prepare")(function* (target: ConnectionTarget) {
    const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
    if (options?.prepare) {
      return yield* options.prepare(attempt, target);
    }
    return PREPARED_CONNECTION;
  });

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* prepare(target);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig: Effect.die(new Error("Initial config is not used by supervisor tests.")),
        subscribeServerConfig: (input) => TEST_RPC_CLIENT.subscribeServerConfig(input),
        ready: options?.ready?.(attempt) ?? Effect.void,
        probe: options?.probe?.(attempt) ?? Effect.void,
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );

    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(
          Stream.drop(1),
          Stream.map((event) => event.reason),
        ),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({ connect }),
    ),
  );

  return {
    dependencies,
    prepareCount,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason,
      })),
    closeLatestSession: Effect.fn("TestConnectionHarness.closeLatestSession")(function* (
      error = transient("Session closed."),
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.fail(latest, error);
      }
    }),
  };
});

describe("EnvironmentSupervisor", () => {
  it.effect("exports each relay setup as a standalone linked trace that ends at readiness", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            spans.push(span);
          };
          return span;
        },
      });
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(RelayClientTracer, Option.some(tracer)),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      const firstAttempt = spans.find((span) => span.name === "relay.connection.attempt");
      expect(firstAttempt).toBeDefined();

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      const attempts = spans.filter((span) => span.name === "relay.connection.attempt");
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.traceId).not.toBe(attempts[1]?.traceId);
      expect(attempts[1]?.links.map((link) => link.span.spanId)).toContain(attempts[0]?.spanId);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not attempt a connection until it is desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);
    }),
  );

  it.effect("does not let the initial connect signal cancel the first attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);

      yield* harness.setNetworkStatus("online");
      const ready = yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(ready).toMatchObject({
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("resets retries when activation arrives before the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* harness.setNetworkStatus("offline");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "offline" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "offline" && state.attempt === 1,
      );
      yield* harness.setNetworkStatus("online");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );
    }),
  );

  it.effect("retries forever with exponential backoff capped at sixteen seconds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.fail(transient()),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      for (const [index, delay] of [3_000, 4_000, 8_000, 16_000, 16_000, 16_000].entries()) {
        yield* TestClock.adjust(delay);
        yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === index + 2,
        );
      }

      expect(yield* Ref.get(harness.prepareCount)).toBe(7);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("Relay connection timed out.")) : Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");

      const retrying = yield* awaitState(
        supervisor.state,
        (state) =>
          state.phase === "connecting" && state.stage === "preparing" && state.attempt === 2,
      );
      expect(retrying).toMatchObject({
        phase: "connecting",
        stage: "preparing",
        attempt: 2,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Relay connection timed out.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retries when a session never becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ready: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "synchronizing",
      );
      yield* TestClock.adjust("14 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).stage).toBe("synchronizing");

      yield* TestClock.adjust("1 second");
      const retrying = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      expect(retrying).toMatchObject({
        phase: "backoff",
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("interrupts and releases a connection attempt when setup times out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Test environment connection failed unexpectedly.",
        },
      });

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("explicit retry starts a fresh backoff sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.fail(transient()),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      yield* supervisor.retryNow;
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);

      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      yield* TestClock.adjust("1 milli");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(4);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps blocked failures idle until an external signal requests another attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resets retries when activation wakes a blocked connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.fail(transient())
            : attempt === 2
              ? Effect.fail(blocked())
              : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "blocked" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases a live session while offline and starts a new generation when online", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.setNetworkStatus("offline");
      yield* awaitState(supervisor.state, (state) => state.phase === "offline");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      yield* harness.setNetworkStatus("online");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }),
  );

  it.effect("retries a blocked connection when platform credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("does not let platform wakeups reset an in-flight attempt", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* Effect.all(
        [
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("treats an involuntary session close as transient and reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(Option.isSome(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps escalating backoff when a newly opened session flaps", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      yield* harness.closeLatestSession();
      const secondFailure = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      expect(secondFailure.retryAt).not.toBeNull();

      yield* TestClock.adjust("3 seconds");
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);

      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when mobile returns to the foreground", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3 && state.attempt === 1,
      );
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a long resume replaces a connected session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3 && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a long resume interrupts connection setup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 2 ? Effect.never : Effect.succeed(PREPARED_CONNECTION)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("probes the active session without reconnecting on application activation", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const probeCalled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () =>
          Ref.update(probeCount, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(probeCalled, undefined)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeCalled);

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("immediately replaces a mobile session after a long background resume", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(probeCount)).toBe(0);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("replaces a mobile session when a long resume interrupts an active probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active-probe");
      yield* Effect.yieldNow;
      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("reconnects immediately when the foreground liveness probe fails", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      const reconnecting = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting",
      );
      expect(reconnecting.attempt).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      // No TestClock advance: a failed wake probe skips the first backoff rung.
      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps normal backoff when a reconnect after a failed wake probe also fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      // The immediate follow-up attempt fails: only the first attempt after
      // the wake probe skips the ladder, so this failure backs off normally.
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      yield* TestClock.adjust("1 milli");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("uses the full tolerance window for a stalled desktop foreground probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("14999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("quickly times out a stalled mobile foreground liveness probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("3 seconds");
      // The timed-out wake probe reconnects immediately without a backoff
      // sleep: no further clock advance is needed.
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("honors an explicit disconnect while a foreground probe is stalled", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("does not churn a healthy session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("releases and reconnects a relay session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("hands off relay authorization after the replacement session is ready", () =>
    Effect.gen(function* () {
      const tokenLifetimeMs = DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS * 2;
      const replacementStarted = yield* Deferred.make<void>();
      const releaseReplacement = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Effect.fail(transient("Authorization refresh failed."))
            : Effect.succeed({
                ...PREPARED_CONNECTION,
                target: RELAY_TARGET,
                httpAuthorization: {
                  _tag: "Dpop",
                  accessToken: `access-token-${attempt}`,
                  expiresAtEpochMs: tokenLifetimeMs * attempt,
                },
              }),
        ready: (attempt) =>
          attempt === 2
            ? Deferred.succeed(replacementStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseReplacement)),
              )
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const firstSession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const firstPrepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      yield* TestClock.adjust(DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS - 1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust(1);
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      yield* Effect.yieldNow;

      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      yield* TestClock.adjust("1 milli");
      yield* Deferred.await(replacementStarted);

      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(firstSession);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared))).toBe(
        firstPrepared,
      );

      yield* Deferred.succeed(releaseReplacement, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).not.toBe(
        firstSession,
      );
      expect(
        Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).httpAuthorization,
      ).toMatchObject({ accessToken: "access-token-3" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cleans up timed-out replacements and an interrupted retry", () =>
    Effect.gen(function* () {
      const tokenLifetimeMs = DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS * 2;
      const replacementStarted = yield* Deferred.make<void>();
      const retryStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          Effect.succeed({
            ...PREPARED_CONNECTION,
            target: RELAY_TARGET,
            httpAuthorization: {
              _tag: "Dpop",
              accessToken: `access-token-${attempt}`,
              expiresAtEpochMs: tokenLifetimeMs * attempt,
            },
          }),
        ready: (attempt) => {
          if (attempt === 2) {
            return Deferred.succeed(replacementStarted, undefined).pipe(
              Effect.andThen(Effect.never),
            );
          }
          if (attempt === 3) {
            return Deferred.succeed(retryStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        },
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const firstSession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      yield* TestClock.adjust(DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS);
      yield* Deferred.await(replacementStarted);

      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(firstSession);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);

      yield* TestClock.adjust("15 seconds");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(firstSession);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });

      yield* TestClock.adjust("3 seconds");
      yield* Deferred.await(retryStarted);
      expect(yield* Ref.get(harness.sessionCount)).toBe(3);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(firstSession);

      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(3);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not keep a relay session past its authorization expiry", () =>
    Effect.gen(function* () {
      const tokenLifetimeMs = DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS * 2;
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.succeed({
                ...PREPARED_CONNECTION,
                target: RELAY_TARGET,
                httpAuthorization: {
                  _tag: "Dpop",
                  accessToken: "access-token-1",
                  expiresAtEpochMs: tokenLifetimeMs,
                },
              })
            : Effect.fail(transient("Authorization refresh failed.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* TestClock.adjust(DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS);
      yield* Effect.yieldNow;
      for (const delay of [3_000, 4_000, 8_000, 16_000, 16_000, 13_000]) {
        yield* TestClock.adjust(delay);
        yield* Effect.yieldNow;
      }

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "backoff",
        generation: 1,
      });
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("interrupts relay setup when credentials change", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }),
  );

  it.effect("explicit disconnect releases the session and returns to available", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }),
  );

  it.effect("does not lose an explicit disconnect among concurrent wakeup signals", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* Effect.all(
        [
          supervisor.disconnect,
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
    }),
  );
});
