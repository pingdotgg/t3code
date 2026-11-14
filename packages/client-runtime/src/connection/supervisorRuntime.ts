import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  type ConnectionRouteKind,
  entryWithRoutes,
  insertRoute,
} from "./routes.ts";

import {
  CONNECTION_PROBE_TIMEOUT,
  QUICK_CONNECTION_PROBE_TIMEOUT,
  SILENT_SOCKET_CHECK_AFTER,
  SILENT_SOCKET_RECHECK_EVERY,
  REMOTE_SILENT_SOCKET_AFTER,
  type SupervisorIntent,
  type SupervisorSignal,
  type PendingRetryTrace,
  type ConnectedLease,
  type TracedAttemptFailure,
  type EnvironmentSupervisorOptions,
  type SilentRoute,
  backOffSilentRoute,
  annotateTarget,
  availableState,
  offlineState,
  connectingState,
} from "./supervisorModel.ts";

// Stage one of the supervisor: services, refs and the connection-attempt
// helpers. It returns the state the run loop and the control surface share, so
// both can be built from the same object identity.
export const makeSupervisorRuntime = Effect.fn("makeSupervisorRuntime")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
) {
  const target = entry.target;
  const usesRelay = connectionRoutes(entry).some(
    (route) => route.target._tag === "RelayConnectionTarget",
  );
  const setupTimeoutDetail = `${target.label} did not respond during connection setup.${
    usesRelay ? ` ${NETWORK_BLOCKING_HINT}` : ""
  }`;
  yield* annotateTarget(target);

  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  // The primary environment served this client or runs beside it on loopback,
  // so the device reporting offline (often wrongly) never parks it. The report
  // still probes its live session, like any other network change.
  const targetNetwork = (network: NetworkStatus): NetworkStatus =>
    network === "offline" && target._tag === "PrimaryConnectionTarget" ? "unknown" : network;
  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: targetNetwork(yield* connectivity.status),
  };
  const intent = yield* Ref.make(initialIntent);
  const signals = yield* Queue.unbounded<SupervisorSignal>();
  const resetRetryState = yield* Ref.make(false);
  const probeUnanswered = yield* Ref.make(false);
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
    !initialIntent.desired
      ? availableState(initialIntent, 0)
      : initialIntent.network === "offline"
        ? offlineState(initialIntent, 0, 0, null)
        : connectingState(initialIntent, 0, 1, null),
  );
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  // Learned routes arrive while a session is live, so the route list is read
  // fresh by each attempt and check instead of being fixed at creation.
  const currentEntry = yield* Ref.make(entry);
  const currentRoutes = Ref.get(currentEntry).pipe(Effect.map(connectionRoutes));
  const preferredRouteId = yield* Ref.make(Option.none<string>());
  const routeCooldowns = yield* Ref.make<ReadonlyMap<string, bigint>>(new Map());
  // The generation keeps a check that started before a reset from recording
  // its stale failures after it.
  const silentRoutes = yield* Ref.make({
    generation: 0,
    routes: new Map<string, SilentRoute>() as ReadonlyMap<string, SilentRoute>,
  });
  const forgetSilentRoutes = Ref.update(silentRoutes, ({ generation }) => ({
    generation: generation + 1,
    routes: new Map(),
  }));

  const attemptEntry = Effect.gen(function* () {
    const latest = yield* Ref.get(currentEntry);
    const routes = connectionRoutes(latest);
    const preferred = yield* Ref.getAndSet(preferredRouteId, Option.none());
    if (Option.isNone(preferred)) return latest;
    const route = routes.find(
      (candidate) => connectionRouteId(candidate.target) === preferred.value,
    );
    return route === undefined
      ? latest
      : entryWithRoutes(latest, [route, ...routes.filter((candidate) => candidate !== route)]);
  });

  const learnRoutesFrom = Effect.fnUntraced(function* (
    learn: NonNullable<EnvironmentSupervisorOptions["learnRoutes"]>,
    lease: ConnectedLease,
  ) {
    const activeRoute = lease.activeRoute;
    if (activeRoute === undefined) return;
    yield* lease.session.subscribeServerConfig().pipe(
      Stream.filter((event) => event.type === "snapshot"),
      Stream.map((event) => event.config.directEndpoints),
      Stream.filter((reported) => reported !== undefined),
      Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
      Stream.runForEach((reported) =>
        Effect.gen(function* () {
          const updated = yield* learn({ activeRoute, reported });
          if (Option.isSome(updated)) {
            yield* Ref.set(currentEntry, updated.value);
            yield* requestBetterRouteCheck(lease);
          }
        }),
      ),
      Effect.ignoreCause({ log: true }),
    );
  });

  const routeIndex = (lease: ConnectedLease) =>
    currentRoutes.pipe(
      Effect.map((routes) => {
        const activeId = connectionRouteId(lease.prepared.target);
        const index = routes.findIndex((route) => connectionRouteId(route.target) === activeId);
        return index === -1 && lease.activeRoute !== undefined
          ? insertRoute(routes, lease.activeRoute).findIndex(
              (route) => connectionRouteId(route.target) === activeId,
            )
          : index;
      }),
    );

  const checkBetterRoutes = Effect.fnUntraced(function* (lease: ConnectedLease) {
    const latest = yield* Ref.get(currentEntry);
    const current = yield* routeIndex(lease);
    if (current <= 0) return;
    const now = yield* Clock.monotonicTimeNanos;
    const cooldowns = yield* Ref.get(routeCooldowns);
    const silent = yield* Ref.get(silentRoutes);
    const better = connectionRoutes(latest)
      .slice(0, current)
      .filter((route) => {
        const id = connectionRouteId(route.target);
        return (cooldowns.get(id) ?? 0n) <= now && (silent.routes.get(id)?.until ?? 0n) <= now;
      });
    const results = yield* Effect.forEach(
      better,
      (route: ConnectionRoute) => driver.preflight(latest, route),
      { concurrency: "unbounded" },
    );
    yield* Ref.update(silentRoutes, (previous) => {
      if (previous.generation !== silent.generation) return previous;
      const routes = new Map(previous.routes);
      for (const [position, route] of better.entries()) {
        const id = connectionRouteId(route.target);
        if (results[position] !== "silent") routes.delete(id);
        else routes.set(id, backOffSilentRoute(previous.routes.get(id), now));
      }
      return { generation: previous.generation, routes };
    });
    const index = results.indexOf("ready");
    if (index === -1) return;
    const live = yield* SubscriptionRef.get(session);
    if (Option.isNone(live) || live.value !== lease.session) return;
    yield* signal({
      _tag: "BetterRouteAvailable",
      routeId: connectionRouteId(better[index]!.target),
    });
  });

  const betterRouteChecks = yield* Queue.dropping<ConnectedLease>(1);
  const requestBetterRouteCheck = (lease: ConnectedLease) =>
    routeIndex(lease).pipe(
      Effect.flatMap((index) =>
        index > 0 ? Queue.offer(betterRouteChecks, lease).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const clearLease = Effect.all(
    [SubscriptionRef.set(session, Option.none()), SubscriptionRef.set(prepared, Option.none())],
    { discard: true },
  );

  const setState = Effect.fn("EnvironmentSupervisor.setState")(function* (
    next: SupervisorConnectionState,
  ) {
    yield* SubscriptionRef.set(state, next);
  });

  const signal = Effect.fn("EnvironmentSupervisor.signal")(function* (next: SupervisorSignal) {
    yield* Queue.offer(signals, next);
  });

  const logManagedRelayAccountChange = Effect.logInfo(
    "Managed relay account changed; restarting the environment connection.",
  ).pipe(
    Effect.annotateLogs({
      "environment.id": target.environmentId,
      "environment.label": target.label,
    }),
  );

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if ("prepared" in progress) {
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }
    yield* setState(
      connectingState(yield* Ref.get(intent), generation, attempt, lastFailure, progress.stage),
    );
  });

  const establishConnection = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    synchronizedRoutes: Ref.Ref<number>,
  ) {
    return yield* driver.connect(yield* attemptEntry, (progress) =>
      (progress.stage === "synchronizing"
        ? Ref.update(synchronizedRoutes, (count) => count + 1)
        : Effect.void
      ).pipe(Effect.andThen(reportProgress(attempt, generation, lastFailure, progress))),
    );
  });

  // Low-cardinality dimensions for time-to-connected dashboards; the error
  // detail stays in the span status, never in an attribute.
  const annotateAttemptOutcome = Effect.fnUntraced(function* (
    exit: Exit.Exit<ConnectionDriver.EnvironmentConnectionLease, ConnectionAttemptError>,
  ) {
    if (Exit.isSuccess(exit)) {
      const leaseTarget = exit.value.prepared.target;
      const route = (yield* currentRoutes).find(
        (candidate) => connectionRouteId(candidate.target) === connectionRouteId(leaseTarget),
      );
      return yield* Effect.annotateCurrentSpan({
        "connection.outcome": "connected",
        "connection.route": connectionRouteKind(
          route ?? { target: leaseTarget, profile: Option.none() },
        ),
      });
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
      return yield* Effect.annotateCurrentSpan("connection.outcome", "interrupted");
    }
    const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
    yield* Effect.annotateCurrentSpan({
      "connection.outcome": "failed",
      "connection.failure.tag": failure?._tag ?? "defect",
      "connection.failure.reason": failure?.reason ?? "defect",
    });
  });

  const traceRelayEstablishment = (
    effect: Effect.Effect<
      ConnectionDriver.EnvironmentConnectionLease,
      ConnectionAttemptError,
      Scope.Scope
    >,
    attempt: number,
    generation: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) => {
    // The span must end with the ConnectionAttemptError itself: the exporter
    // can only describe an Error-like failure, and a TracedAttemptFailure
    // wrapper reached it as "[object Object]". The wrapper is added outside.
    let attemptSpan = Option.none<Tracer.Span>();
    const traced = Effect.gen(function* () {
      attemptSpan = Option.some(yield* Effect.currentSpan.pipe(Effect.orDie));
      yield* annotateTarget(target);
      yield* Effect.annotateCurrentSpan({
        "connection.attempt": attempt,
        "connection.generation": generation,
        "connection.retry.failure_count": Option.match(pendingRetry, {
          onNone: () => 0,
          onSome: (retry) => retry.failureCount,
        }),
      });
      return yield* effect.pipe(Effect.onExit(annotateAttemptOutcome));
    }).pipe(Effect.withSpan("relay.connection.attempt", { root: true }));

    return Option.match(pendingRetry, {
      onNone: () => traced,
      onSome: (retry) =>
        traced.pipe(
          Effect.linkSpans(retry.previousAttempt, {
            "connection.retry.delay_ms": retry.delayMs,
            "connection.retry.reason": retry.reason,
          }),
        ),
    }).pipe(
      Effect.map((lease) => ({ attemptSpan, lease })),
      Effect.mapError((error): TracedAttemptFailure => ({ error, attemptSpan })),
      withRelayClientTracing,
    );
  };

  const establishTracedConnection = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    synchronizedRoutes: Ref.Ref<number>,
  ) {
    if (usesRelay) {
      return yield* traceRelayEstablishment(
        establishConnection(attempt, generation, lastFailure, synchronizedRoutes),
        attempt,
        generation,
        pendingRetry,
      );
    }
    return yield* establishConnection(attempt, generation, lastFailure, synchronizedRoutes).pipe(
      Effect.map((lease) => ({
        attemptSpan: Option.none<Tracer.Span>(),
        lease,
      })),
      Effect.mapError((error): TracedAttemptFailure => ({
        error,
        attemptSpan: Option.none(),
      })),
    );
  });

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* () {
    // A primary attempt keeps running through an offline report, so the
    // network returning restarts it in case it stalled meanwhile.
    let deviceOffline = (yield* connectivity.status) === "offline";
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          return false;
        case "NetworkChanged":
          if (target._tag !== "PrimaryConnectionTarget") {
            if (next.network === "offline") {
              return false;
            }
          } else if (next.network === "offline") {
            deviceOffline = true;
          } else if (deviceOffline) {
            return true;
          }
          break;
        case "ConnectRequested":
        case "BetterRouteAvailable":
          break;
        case "Wakeup":
          // An attempt that ran into a long suspension is likely stuck.
          if (next.reason === "application-active-long") {
            return true;
          }
          if (next.reason === "credentials-changed" && usesRelay) {
            yield* logManagedRelayAccountChange;
            return false;
          }
          break;
      }
    }
  });

  const isRelayLease = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    lease.prepared.target._tag === "RelayConnectionTarget";

  const connectedLeaseEnd = Effect.fnUntraced(function* (
    next: SupervisorSignal,
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    if (next._tag === "DisconnectRequested") {
      return "end" as const;
    }
    if (next._tag === "BetterRouteAvailable") {
      yield* Ref.set(preferredRouteId, Option.some(next.routeId));
      return "reset" as const;
    }
    // Only a session over T3 Connect holds the old account's credential.
    if (next._tag === "Wakeup" && next.reason === "credentials-changed" && isRelayLease(lease)) {
      yield* logManagedRelayAccountChange;
      return "end" as const;
    }
    return undefined;
  });

  const leaseRouteKind = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    currentRoutes.pipe(
      Effect.map((routes) => {
        const route = routes.find(
          (candidate) =>
            connectionRouteId(candidate.target) === connectionRouteId(lease.prepared.target),
        );
        return route === undefined ? undefined : connectionRouteKind(route);
      }),
    );

  const isLongResume = (signal: SupervisorSignal) =>
    signal._tag === "Wakeup" && signal.reason === "application-active-long";

  const answersQuickly = (routeKind: ConnectionRouteKind | undefined) =>
    routeKind === "loopback" || routeKind === "lan";

  const probeTimeoutFor = (
    next: SupervisorSignal,
    routeKind: ConnectionRouteKind | undefined,
  ): Duration.Input | undefined => {
    switch (next._tag) {
      case "RetryRequested":
        return QUICK_CONNECTION_PROBE_TIMEOUT;
      case "NetworkChanged":
        return next.network === "offline" ? QUICK_CONNECTION_PROBE_TIMEOUT : undefined;
      case "Wakeup":
        if (next.reason === "application-active") {
          return CONNECTION_PROBE_TIMEOUT;
        }
        // After a long suspension the data on screen is stale, so a slow
        // answer reconnects as quickly as a missing one, even on a remote
        // route where a reconnect takes longer than the wait it replaces.
        if (next.reason === "application-active-long") {
          return QUICK_CONNECTION_PROBE_TIMEOUT;
        }
        if (next.reason !== "application-active-probe" && next.reason !== "network-changed") {
          return undefined;
        }
        // Only loopback and LAN answer within 3 seconds reliably. A tailnet
        // over DERP, a VPN, or the relay can spike past it on a live socket;
        // a dead one is still caught early by the silent socket check.
        return answersQuickly(routeKind)
          ? QUICK_CONNECTION_PROBE_TIMEOUT
          : CONNECTION_PROBE_TIMEOUT;
      case "ConnectRequested":
      case "DisconnectRequested":
      case "BetterRouteAvailable":
        return undefined;
    }
  };

  // Ends "silent" when the host answers a fresh request while the socket
  // delivers nothing, as when iOS kills a suspended socket without a close
  // event, and "alive" once the socket delivers a frame. A slow or
  // unreachable host never ends it.
  const awaitSilentSocket = Effect.fn("EnvironmentSupervisor.awaitSilentSocket")(function* (
    lease: ConnectedLease,
    routeKind: ConnectionRouteKind | undefined,
  ) {
    const startedAt = yield* Clock.monotonicTimeNanos;
    yield* Effect.sleep(SILENT_SOCKET_CHECK_AFTER);
    const configLoaded = yield* lease.session.initialConfig.pipe(
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (!configLoaded) return yield* Effect.never;
    // Frames that queued while the app was suspended have drained by now, so
    // a later frame shows the path still works.
    const framesBefore = yield* lease.session.inboundFrames;
    const socketSilent = lease.session.inboundFrames.pipe(
      Effect.map((frames) => frames === framesBefore),
    );
    // A radio still waking up or a stale pooled connection can fail one check.
    while ((yield* driver.checkHost(lease.prepared)) !== "answered") {
      if (!(yield* socketSilent)) return "alive" as const;
      yield* Effect.sleep(SILENT_SOCKET_RECHECK_EVERY);
    }
    if (!answersQuickly(routeKind)) {
      const silentFor = (yield* Clock.monotonicTimeNanos) - startedAt;
      const remaining = Duration.toNanosUnsafe(REMOTE_SILENT_SOCKET_AFTER) - silentFor;
      if (remaining > 0n) yield* Effect.sleep(Duration.nanos(remaining));
    }
    return (yield* socketSilent) ? ("silent" as const) : ("alive" as const);
  });

  // Returning to the app, an explicit retry, and the network reporting offline
  // all probe the live session instead of replacing it, so a healthy socket is
  // not torn down (the offline report is often wrong, for example for a
  // loopback server).

  return {
    target,
    usesRelay,
    setupTimeoutDetail,
    connectivity,
    driver,
    wakeups,
    targetNetwork,
    initialIntent,
    intent,
    signals,
    resetRetryState,
    probeUnanswered,
    state,
    session,
    prepared,
    currentEntry,
    currentRoutes,
    preferredRouteId,
    routeCooldowns,
    silentRoutes,
    forgetSilentRoutes,
    attemptEntry,
    learnRoutesFrom,
    routeIndex,
    checkBetterRoutes,
    betterRouteChecks,
    requestBetterRouteCheck,
    clearLease,
    setState,
    signal,
    logManagedRelayAccountChange,
    reportProgress,
    establishConnection,
    annotateAttemptOutcome,
    traceRelayEstablishment,
    establishTracedConnection,
    waitForEstablishmentInterrupt,
    isRelayLease,
    connectedLeaseEnd,
    leaseRouteKind,
    isLongResume,
    answersQuickly,
    probeTimeoutFor,
    awaitSilentSocket,
    options,
  };
});
