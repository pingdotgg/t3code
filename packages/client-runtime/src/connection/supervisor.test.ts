import { AuthStandardClientScopes, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import {
  BearerConnectionTarget,
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
import { presentConnectionState } from "./presentation.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { connectionRouteId, entryWithRoutes, isLearned, mergeLearnedRoutes } from "./routes.ts";

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
  enabled: true,
};

const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: RELAY_TARGET,
  profile: Option.none(),
  enabled: true,
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

const LAN_TARGET = new BearerConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  connectionId: "bearer:lan",
});
const LAN_ROUTE: ConnectionRoute = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
};
const LAN_THEN_RELAY_ENTRY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  alternateRoutes: [{ target: RELAY_TARGET, profile: Option.none() }],
  enabled: true,
};

const LAN_ENTRY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  enabled: true,
};

const PROBE_CAPABLE_CONFIG = {
  environment: { capabilities: { connectionProbe: true } },
} as ServerConfig;

function preparedFor(target: ConnectionTarget): PreparedConnection {
  return { ...PREPARED_CONNECTION, target };
}

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

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (
    attempt: number,
    target: ConnectionTarget,
  ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly initialConfig?: (attempt: number) => Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly checkRoute?: (route: ConnectionRoute) => Effect.Effect<ConnectionDriver.RouteCheck>;
  readonly checkHost?: (prepared: PreparedConnection) => Effect.Effect<ConnectionDriver.RouteCheck>;
  readonly inboundFrames?: Effect.Effect<number>;
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

  const checkRoute = (route: ConnectionRoute) =>
    options?.checkRoute?.(route) ?? Effect.succeed<ConnectionDriver.RouteCheck>("unchecked");

  const connectRoute = Effect.fn("TestConnectionDriver.connectRoute")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const prepared = yield* prepare(target);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig:
          options?.initialConfig?.(attempt) ??
          Effect.die(new Error("Initial config is not used by supervisor tests.")),
        subscribeServerConfig: (input) => TEST_RPC_CLIENT.subscribeServerConfig(input),
        ready: options?.ready?.(attempt) ?? Effect.void,
        probe: options?.probe?.(attempt) ?? Effect.void,
        inboundFrames: options?.inboundFrames ?? Effect.succeed(0),
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );

    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    return yield* ConnectionDriver.connectOverRoutes(entry, checkRoute, (route) =>
      connectRoute(route.target, reportProgress),
    );
  });

  const layerDependencies = Layer.mergeAll(
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
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
      ConnectionDriver.ConnectionDriver.of({
        connect,
        preflight: (_entry, route) =>
          checkRoute(route).pipe(Effect.map((check) => check === "answered")),
        checkHost: (prepared) =>
          options?.checkHost?.(prepared) ??
          Effect.succeed<ConnectionDriver.RouteCheck>("unchecked"),
      }),
    ),
  );

  return {
    dependencies: layerDependencies,
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

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
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
      const retrying = yield* awaitState(
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

  it.effect("does not report a session lost while suspended as a failed connection", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      // The OS killed the socket while the app was suspended; its close arrives
      // before the app reports it is active again.
      yield* harness.closeLatestSession();
      const waiting = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(presentConnectionState(waiting)).toEqual({
        phase: "reconnecting",
        error: null,
        traceId: null,
      });

      yield* harness.wake("application-active");
      const replacing = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      expect(presentConnectionState(replacing).error).toBeNull();

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a resume replaces a silent socket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 2 ? Effect.never : Effect.void),
        checkHost: () => Effect.succeed("answered"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 2,
      );

      yield* harness.wake("application-active-long");
      yield* TestClock.adjust("500 millis");
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

      yield* harness.wake("application-active-long");
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

  it.effect("keeps a live mobile session after a long background resume", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-long");
      yield* TestClock.adjust("5 seconds");

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  const makeSilentSocketHarness = (options?: {
    readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
    readonly checkHost?: (check: number) => ConnectionDriver.RouteCheck;
  }) =>
    Effect.gen(function* () {
      const hostChecks = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: options?.probe ?? ((attempt) => (attempt === 1 ? Effect.never : Effect.void)),
        checkHost: (prepared) =>
          Ref.updateAndGet(hostChecks, (checks) => [...checks, prepared.target._tag]).pipe(
            Effect.map((checks) => options?.checkHost?.(checks.length) ?? "answered"),
          ),
      });
      return { ...harness, hostChecks };
    });

  it.effect.each(["application-active-probe", "application-active-long"] as const)(
    "replaces a LAN socket that stays silent while its host answers afresh (%s)",
    (wakeup) =>
      Effect.gen(function* () {
        const harness = yield* makeSilentSocketHarness();
        const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.wake(wakeup);
        yield* TestClock.adjust("499 millis");
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);

        yield* TestClock.adjust("1 millis");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(yield* Ref.get(harness.hostChecks)).toEqual(["BearerConnectionTarget"]);
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a remote socket only after 2.5 seconds of silence", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("2499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.hostChecks)).toEqual(["RelayConnectionTarget"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a silent socket even while the network reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("500 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a remote socket after a long resume while the network reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.setNetworkStatus("offline");
      yield* harness.wake("application-active-long");
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host afresh when the network changes after a frame", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        inboundFrames: Ref.get(frames),
        checkHost: () => Effect.succeed("answered"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("1 second");
      yield* Ref.update(frames, (count) => count + 1);
      yield* TestClock.adjust("1 second");
      yield* harness.wake("network-changed");
      // The running check sees the frame at 2.5 s, so a fresh one starts then.
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a running check's window when the network changes during a long resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-long");
      yield* TestClock.adjust("1 second");
      yield* harness.wake("network-changed");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("1500 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host again when one check goes unanswered", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness({
        checkHost: (check) => (check === 1 ? "silent" : "answered"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("1499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.hostChecks)).toHaveLength(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("leaves a web or desktop foreground probe to its own deadline", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness({
        probe: (attempt) => (attempt === 1 ? Effect.sleep("4 seconds") : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("20 seconds");

      expect(yield* Ref.get(harness.hostChecks)).toEqual([]);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host when a network change arrives during a foreground probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("100 millis");
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps waiting for the probe when a frame arrives during the host check", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.sleep("2 seconds") : Effect.void),
        inboundFrames: Ref.get(frames),
        checkHost: () => Ref.update(frames, (count) => count + 1).pipe(Effect.as("answered")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("5 seconds");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("waits out a LAN resume probe when the host does not answer a fresh request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        checkHost: () => Effect.succeed("silent"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["application-active-probe", "network-changed"] as const)(
    "gives a live remote socket 15 seconds to answer a %s probe",
    (wakeup) =>
      Effect.gen(function* () {
        // A slow path delays the fresh request as much as the probe.
        const harness = yield* makeSilentSocketHarness({
          probe: (attempt) => (attempt === 1 ? Effect.sleep("4 seconds") : Effect.void),
          checkHost: () => "silent",
        });
        const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.wake(wakeup);
        yield* TestClock.adjust("20 seconds");

        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces an unanswered long resume probe even while the network reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-long");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.lastFailure).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the session closes during a resume probe", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 1
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* Deferred.await(probeStarted);
      yield* harness.closeLatestSession();

      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.attempt).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
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
      expect(reconnecting.lastFailure).toBeNull();
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
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
      const harness = yield* makeHarness({
        prepare: () => Effect.succeed(preparedFor(RELAY_TARGET)),
      });
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

  it.effect("refreshes HTTP authorization without replacing the active relay session", () =>
    Effect.gen(function* () {
      const endpoint = {
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
        providerKind: "cloudflare_tunnel" as const,
      };
      const token = yield* Ref.make(
        Option.some(
          new TokenStore.RemoteDpopAccessToken({
            environmentId: TARGET.environmentId,
            accountId: "test-account",
            label: TARGET.label,
            endpoint,
            accessToken: "access-token-1",
            expiresAtEpochMs: 3_600_000,
            dpopThumbprint: "test-thumbprint",
          }),
        ),
      );
      const bootstrapFails = yield* Ref.make(false);
      const bootstrapCalls = yield* Ref.make(0);
      const httpPaths: Array<string> = [];
      const sessionAuthorizations: Array<string | null> = [];
      const fetchFn = ((input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        httpPaths.push(pathname);
        switch (pathname) {
          case "/.well-known/t3/environment":
            return Promise.resolve(
              Response.json({
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            );
          case "/oauth/token":
            return Promise.resolve(
              Response.json({
                access_token: "access-token-2",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 3_600,
                scope: AuthStandardClientScopes.join(" "),
              }),
            );
          case "/api/auth/websocket-ticket/rpc":
            return Promise.resolve(
              Response.json({
                ticket: "ws-ticket",
                expiresAt: "2026-09-04T01:00:00.000Z",
              }),
            );
          case "/api/auth/session": {
            const authorization = request.headers.get("authorization");
            sessionAuthorizations.push(authorization);
            return Promise.resolve(
              Response.json({
                authenticated: authorization === "DPoP access-token-2",
                auth: {
                  policy: "loopback-browser",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["dpop-access-token"],
                  sessionCookieName: "t3_session_test",
                },
                scopes: AuthStandardClientScopes,
              }),
            );
          }
          default:
            return Promise.reject(new Error(`Unexpected HTTP request to ${request.url}`));
        }
      }) satisfies typeof fetch;
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: () => Effect.succeed("test-proof"),
      });
      const unused = () => Effect.die("Unexpected relay operation.");
      const relay = ManagedRelay.ManagedRelayClient.of({
        relayUrl: "https://relay.example.test",
        listEnvironments: unused,
        listDevices: unused,
        createEnvironmentLinkChallenge: unused,
        linkEnvironment: unused,
        unlinkEnvironment: unused,
        getT3ChatLink: unused,
        createT3ChatLinkRequest: unused,
        unlinkT3Chat: unused,
        getEnvironmentStatus: unused,
        connectEnvironment: Effect.fn("TestConnectionHttp.connectEnvironment")(function* () {
          yield* Ref.update(bootstrapCalls, (count) => count + 1);
          if (yield* Ref.get(bootstrapFails)) {
            return yield* new ManagedRelay.ManagedRelayRequestTimeoutError({
              activity: "Relay environment connection",
              timeoutMs: 6_000,
              traceId: null,
            });
          }
          return {
            environmentId: TARGET.environmentId,
            endpoint,
            credential: "relay-bootstrap",
            expiresAt: "2026-09-04T01:00:00.000Z",
          };
        }),
        registerDevice: unused,
        unregisterDevice: unused,
        registerLiveActivity: unused,
        getAgentActivitySnapshot: unused,
        resetTokenCache: Effect.void,
      });
      const layerHttp = RpcHttp.layerRemoteHttpClient(fetchFn);
      const remoteAuthorization = yield* RemoteEnvironmentAuthorization.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerHttp,
            Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
            Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
            Layer.succeed(ClientCapabilities.CloudSession, {
              identity: Effect.succeedSome({ accountId: "test-account" }),
              clerkToken: Effect.succeed("clerk-token"),
            }),
            Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
              deviceId: Effect.succeedNone,
            }),
            Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
              get: () => Ref.get(token),
              put: (value) => Ref.set(token, Option.some(value)),
              remove: () => Ref.set(token, Option.none()),
            }),
            Layer.succeed(ClientCapabilities.ClientPresentation, {
              metadata: { label: "Test client", deviceType: "desktop" },
            }),
          ),
        ),
      );
      const harness = yield* makeHarness({
        prepare: () =>
          remoteAuthorization
            .authorizeDpop({ expectedEnvironmentId: TARGET.environmentId })
            .pipe(Effect.map((prepared) => ({ ...prepared, target: RELAY_TARGET }))),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      const readSession = fetchEnvironmentSessionState({
        prepared,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remoteAuthorization),
      }).pipe(Effect.provide(layerHttp));

      yield* TestClock.adjust("2 hours");
      expect((yield* readSession).authenticated).toBe(true);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(yield* Ref.get(bootstrapCalls)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });

      yield* TestClock.adjust("2 hours");
      yield* Ref.set(bootstrapFails, true);
      const failure = yield* readSession.pipe(Effect.flip);
      expect(failure._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(yield* Ref.get(bootstrapCalls)).toBe(2);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(httpPaths.filter((path) => path === "/api/auth/websocket-ticket/rpc")).toHaveLength(1);
      expect(httpPaths.filter((path) => path === "/oauth/token")).toHaveLength(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
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

describe("EnvironmentSupervisor routes", () => {
  it.effect("connects over relay before a slow LAN reachability check times out", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("silent" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("shares one head start across several slow LAN routes", () =>
    Effect.gen(function* () {
      const secondLanTarget = new BearerConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "bearer:second-lan",
      });
      const entry: ConnectionCatalogEntry = {
        ...LAN_THEN_RELAY_ENTRY,
        alternateRoutes: [
          {
            target: secondLanTarget,
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: secondLanTarget.connectionId,
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                httpBaseUrl: "http://192.168.56.1:3773/",
                wsBaseUrl: "ws://192.168.56.1:3773/",
              }),
            ),
          },
          { target: RELAY_TARGET, profile: Option.none() },
        ],
      };
      const checking = yield* Ref.make(0);
      const checkingLans = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.updateAndGet(checking, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2 ? Deferred.succeed(checkingLans, undefined) : Effect.void,
                ),
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("silent" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(entry, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLans);
      yield* TestClock.adjust("500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still prefers a LAN route that responds within its head start", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("100 millis")),
                Effect.as("answered" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("100 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("tries a slow tailnet route that answered before a dead LAN route", () =>
    Effect.gen(function* () {
      const tailnetTarget = new BearerConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "bearer:tailnet",
      });
      // No relay: a Tailscale-only client away from the LAN.
      const entry: ConnectionCatalogEntry = {
        ...LAN_THEN_RELAY_ENTRY,
        alternateRoutes: [
          {
            target: tailnetTarget,
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: tailnetTarget.connectionId,
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                httpBaseUrl: "http://100.100.1.2:3773/",
                wsBaseUrl: "ws://100.100.1.2:3773/",
                network: "tailscale",
              }),
            ),
          },
        ],
      };
      const checking = yield* Ref.make(0);
      const checkingBoth = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Ref.updateAndGet(checking, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 2 ? Deferred.succeed(checkingBoth, undefined) : Effect.void,
            ),
            Effect.andThen(
              connectionRouteId(route.target) === LAN_TARGET.connectionId
                ? Effect.sleep("2500 millis").pipe(Effect.as("silent" as const))
                : Effect.sleep("700 millis").pipe(Effect.as("answered" as const)),
            ),
          ),
        // The dead LAN address never answers the connection itself either.
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget" &&
          target.connectionId === LAN_TARGET.connectionId
            ? Effect.never
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(entry, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingBoth);
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(
        connectionRouteId(
          Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target,
        ),
      ).toBe("bearer:tailnet");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still tries a slow LAN route when relay fails", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const attempted: string[] = [];
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("answered" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => {
          attempted.push(target._tag);
          return target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to T3 Connect."))
            : Effect.succeed(preparedFor(target));
        },
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(attempted).toEqual(["RelayConnectionTarget", "BearerConnectionTarget"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("skips a silent LAN route and connects over T3 Connect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("moves to a blocked route's fallback instead of stopping", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(blocked("The environment credential is invalid."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
    }),
  );

  it.effect("tries every route when none answers the reachability check", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("silent"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("BearerConnectionTarget");
    }),
  );

  it.effect("keeps retrying when one route is blocked and another failed transiently", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to T3 Connect."))
            : Effect.fail(transient("LAN socket refused.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.lastFailure?._tag).toBe("ConnectionTransientError");
    }),
  );

  it.effect("moves back to the LAN route when the network changes and it answers again", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );

      yield* Ref.set(lanReachable, true);
      yield* harness.setNetworkStatus("unknown");
      yield* harness.setNetworkStatus("online");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("moves off a dead LAN socket when the phone switches to cellular", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(true);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        probe: () =>
          Ref.get(lanReachable).pipe(
            Effect.flatMap((reachable) => (reachable ? Effect.void : Effect.never)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );

      yield* Ref.set(lanReachable, false);
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("3 seconds");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
    }),
  );

  it.effect("learns the LAN address over T3 Connect and moves to it", () =>
    Effect.gen(function* () {
      const relayEntry: ConnectionCatalogEntry = {
        target: RELAY_TARGET,
        profile: Option.none(),
        enabled: true,
      };
      const lanAddress = yield* Ref.make("http://192.168.1.10:3773/");
      const learned = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Effect.succeed("answered")
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () =>
          Ref.get(lanAddress).pipe(
            Effect.map((httpBaseUrl): Pick<ServerConfig, "directEndpoints"> => ({
              directEndpoints: [{ kind: "lan", httpBaseUrl }],
            })),
            Effect.map((config) => config as ServerConfig),
          ),
      });
      const current = yield* Ref.make(relayEntry);
      const supervisor = yield* EnvironmentSupervisor.make(relayEntry, {
        initiallyDesired: true,
        learnRoutes: ({ activeRoute, reported }) =>
          Effect.gen(function* () {
            const entry = yield* Ref.get(current);
            const routes = mergeLearnedRoutes({
              entry,
              activeRoute,
              reported,
              allowInsecure: true,
            });
            if (routes === null) return Option.none();
            const next = entryWithRoutes(entry, routes);
            yield* Ref.set(current, next);
            yield* Ref.update(learned, (all) => [
              ...all,
              ...routes.filter(isLearned).map((route) => connectionRouteId(route.target)),
            ]);
            return Option.some(next);
          }),
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(learned)).toEqual([
        `learned:${TARGET.environmentId}:http://192.168.1.10:3773`,
      ]);
    }),
  );
});
