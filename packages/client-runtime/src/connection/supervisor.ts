import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
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
  type ConnectionTarget,
  ConnectionTransientError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  type ConnectionRouteKind,
  entryWithRoutes,
  type ReportedEndpoint,
} from "./routes.ts";

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
// A cold server with a large database can take longer than 15 seconds to
// answer, and that is not a reason to drop a working connection.
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";
const establishmentTimeout = Duration.fromInputUnsafe(CONNECTION_ESTABLISHMENT_TIMEOUT);
const synchronizationTimeout = Duration.fromInputUnsafe("75 seconds");
const CONNECTION_PROBE_TIMEOUT = "15 seconds";
const QUICK_CONNECTION_PROBE_TIMEOUT = "3 seconds";
// A probe still unanswered this long checks the host with a fresh request. If
// the host answers while the socket stays silent, the socket is dead.
const SILENT_SOCKET_CHECK_AFTER = "500 millis";
const SILENT_SOCKET_RECHECK_EVERY = "1 second";
// Off the LAN one lost packet can stall a live socket for a second, so a remote
// socket must stay silent this long. It must end before
// QUICK_CONNECTION_PROBE_TIMEOUT so a long resume replaces a silent socket
// instead of timing out.
const REMOTE_SILENT_SOCKET_AFTER = "2500 millis";
const BACKOFF_RESET_AFTER_MS = 30_000;
const BETTER_ROUTE_CHECK_INTERVAL = "60 seconds";
// A better route that answered the check but then failed to connect is not
// tried again for this long, so a flaky LAN cannot bounce the connection.
const BETTER_ROUTE_COOLDOWN_MS = 300_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup }
  | { readonly _tag: "BetterRouteAvailable"; readonly routeId: string };

interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: TracedAttemptFailure;
    };

type EstablishmentEvent =
  | {
      readonly _tag: "Completed";
      readonly exit: Exit.Exit<
        {
          readonly attemptSpan: Option.Option<Tracer.Span>;
          readonly lease: ConnectionDriver.EnvironmentConnectionLease;
        },
        TracedAttemptFailure
      >;
    }
  | { readonly _tag: "Interrupted"; readonly resetRetry: boolean }
  | { readonly _tag: "TimedOut" };

function exitUnlessInterrupted<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });
}

export interface EnvironmentSupervisorOptions {
  readonly initiallyDesired?: boolean;
  readonly learnRoutes?: (input: {
    readonly activeRoute: ConnectionRoute;
    readonly reported: ReadonlyArray<ReportedEndpoint>;
  }) => Effect.Effect<Option.Option<ConnectionCatalogEntry>>;
}

function retryDelayMs(failureCount: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

function annotateTarget(target: ConnectionTarget) {
  return Effect.annotateCurrentSpan({
    "environment.id": target.environmentId,
    "environment.label": target.label,
    "environment.target.kind": target._tag,
  });
}

function availableState(intent: SupervisorIntent, generation: number): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
  };
}

function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function failureFromExit<A>(
  target: ConnectionTarget,
  exit: Exit.Exit<A, TracedAttemptFailure>,
  established: boolean,
  stable: boolean,
): AttemptOutcome {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return { _tag: "Interrupted", established, stable, resetRetry: false };
  }
  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);
  if (typedFailure) {
    return {
      _tag: "Failure",
      established,
      stable,
      failure: typedFailure.error,
    };
  }
  return {
    _tag: "Failure",
    established,
    stable,
    failure: {
      error: new ConnectionTransientError({
        reason: "transport",
        detail: `${target.label} connection failed unexpectedly.`,
      }),
      attemptSpan: Option.none(),
    },
  };
}

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly target: ConnectionTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  EnvironmentSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | Scope.Scope
  | ConnectionWakeups.ConnectionWakeups
> {
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
  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: yield* connectivity.status,
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
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    const config = yield* lease.session.initialConfig.pipe(Effect.option);
    const reported = Option.getOrUndefined(config)?.directEndpoints;
    if (reported === undefined) return;
    const activeId = connectionRouteId(lease.prepared.target);
    const activeRoute = (yield* currentRoutes).find(
      (route) => connectionRouteId(route.target) === activeId,
    );
    if (activeRoute === undefined) return;
    const updated = yield* learn({ activeRoute, reported });
    if (Option.isSome(updated)) {
      yield* Ref.set(currentEntry, updated.value);
      yield* requestBetterRouteCheck(lease);
    }
  });

  const routeIndex = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    currentRoutes.pipe(
      Effect.map((routes) =>
        routes.findIndex(
          (route) => connectionRouteId(route.target) === connectionRouteId(lease.prepared.target),
        ),
      ),
    );

  const checkBetterRoutes = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    const latest = yield* Ref.get(currentEntry);
    const current = yield* routeIndex(lease);
    if (current <= 0) return;
    const now = yield* Clock.monotonicTimeNanos;
    const cooldowns = yield* Ref.get(routeCooldowns);
    const better = connectionRoutes(latest)
      .slice(0, current)
      .filter((route) => (cooldowns.get(connectionRouteId(route.target)) ?? 0n) <= now);
    const passed = yield* Effect.forEach(
      better,
      (route: ConnectionRoute) => driver.preflight(latest, route),
      { concurrency: "unbounded" },
    );
    const index = passed.indexOf(true);
    if (index === -1) return;
    const live = yield* SubscriptionRef.get(session);
    if (Option.isNone(live) || live.value !== lease.session) return;
    yield* signal({
      _tag: "BetterRouteAvailable",
      routeId: connectionRouteId(better[index]!.target),
    });
  });

  const betterRouteChecks = yield* Queue.dropping<ConnectionDriver.EnvironmentConnectionLease>(1);
  const requestBetterRouteCheck = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
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
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          return false;
        case "NetworkChanged":
          if (next.network === "offline") {
            return false;
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
    lease: ConnectionDriver.EnvironmentConnectionLease,
    routeKind: ConnectionRouteKind | undefined,
  ) {
    const startedAt = yield* Clock.monotonicTimeNanos;
    yield* Effect.sleep(SILENT_SOCKET_CHECK_AFTER);
    // An older host answers probes with its full config, which can be slow
    // enough to lose to a fresh request on a healthy socket.
    const answersCheapProbe = yield* lease.session.initialConfig.pipe(
      Effect.map((config) => config.environment.capabilities.connectionProbe === true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (!answersCheapProbe) return yield* Effect.never;
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
  const monitorConnectedLease = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    // A probe answers an explicit retry here, so the retry must not also reset
    // the backoff of a later, unrelated failure.
    const takeSignal = Queue.take(signals).pipe(
      Effect.tap((next) =>
        next._tag === "RetryRequested" ? Ref.set(resetRetryState, false) : Effect.void,
      ),
    );
    // Ticks always run: the check skips the preferred route itself, and the
    // route list can grow while connected (learned routes).
    yield* Stream.tick(BETTER_ROUTE_CHECK_INTERVAL).pipe(
      Stream.drop(1),
      Stream.runForEach(() => requestBetterRouteCheck(lease)),
      Effect.forkScoped,
    );
    const routeKind = yield* leaseRouteKind(lease);
    for (;;) {
      const next = yield* takeSignal;
      const end = yield* connectedLeaseEnd(next, lease);
      if (end !== undefined) {
        return end === "reset";
      }
      if (
        (next._tag === "NetworkChanged" && next.network !== "offline") ||
        (next._tag === "Wakeup" && ConnectionWakeups.resetsRetryBackoff(next.reason))
      ) {
        yield* requestBetterRouteCheck(lease);
      }
      const probeTimeout = probeTimeoutFor(next, routeKind);
      if (probeTimeout === undefined) {
        continue;
      }
      yield* Ref.set(probeUnanswered, true);
      const probe = yield* Effect.forkChild(lease.session.probe);
      let silentSocket: Fiber.Fiber<"silent" | "alive"> | undefined;
      // A signal during a running check, such as a network change that kills
      // the socket, needs a fresh check only if the running one sees a frame.
      let recheck = false;
      let longResume = isLongResume(next);
      const startSilentSocketCheck = Effect.gen(function* () {
        silentSocket = yield* Effect.forkChild(awaitSilentSocket(lease, routeKind));
        recheck = false;
      });
      // The web and desktop foreground probe allows a busy host 15 seconds,
      // and a busy host can answer a fresh request before a queued probe.
      const armSilentSocketCheck = Effect.fnUntraced(function* (signal: SupervisorSignal) {
        if (signal._tag === "Wakeup" && signal.reason === "application-active") return;
        if (silentSocket !== undefined) {
          recheck = true;
          return;
        }
        yield* startSilentSocketCheck;
      });
      yield* armSilentSocketCheck(next);
      const stopProbe = Effect.suspend(() =>
        Effect.all(
          [Fiber.interrupt(probe), silentSocket ? Fiber.interrupt(silentSocket) : Effect.void],
          { discard: true },
        ),
      );
      let deadline = (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(probeTimeout);
      for (;;) {
        const remaining = deadline - (yield* Clock.monotonicTimeNanos);
        const probeEvent = yield* Effect.raceAllFirst([
          Fiber.await(probe).pipe(
            Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit })),
          ),
          takeSignal.pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
          Effect.sleep(Duration.nanos(remaining > 0n ? remaining : 0n)).pipe(
            Effect.as({ _tag: "TimedOut" as const }),
          ),
          (silentSocket ? Fiber.join(silentSocket) : Effect.never).pipe(
            Effect.map((check) =>
              check === "silent"
                ? { _tag: "SocketSilent" as const }
                : { _tag: "SocketAlive" as const },
            ),
          ),
        ]);
        if (probeEvent._tag === "SocketAlive") {
          silentSocket = undefined;
          if (recheck) yield* startSilentSocketCheck;
          continue;
        }
        if (probeEvent._tag === "SocketSilent") {
          // The host is reachable, so replace the socket at once, even while
          // the network reports offline.
          yield* stopProbe;
          return true;
        }
        if (probeEvent._tag === "TimedOut") {
          yield* stopProbe;
          // A long suspension leaves the socket suspect even when the network
          // reports offline, so it is replaced like a silent one.
          if (longResume) return true;
          return yield* new ConnectionTransientError({
            reason: "timeout",
            detail: `${target.label} did not respond to a connection health check.`,
          });
        }
        if (probeEvent._tag === "ProbeCompleted") {
          if (silentSocket) yield* Fiber.interrupt(silentSocket);
          if (Exit.isSuccess(probeEvent.exit)) {
            yield* Ref.set(probeUnanswered, false);
          }
          yield* probeEvent.exit;
          break;
        }
        const endDuringProbe = yield* connectedLeaseEnd(probeEvent.signal, lease);
        if (endDuringProbe !== undefined) {
          yield* stopProbe;
          return endDuringProbe === "reset";
        }
        const signalTimeout = probeTimeoutFor(probeEvent.signal, routeKind);
        if (signalTimeout !== undefined) {
          yield* armSilentSocketCheck(probeEvent.signal);
          longResume ||= isLongResume(probeEvent.signal);
          const signalDeadline =
            (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(signalTimeout);
          if (signalDeadline < deadline) deadline = signalDeadline;
        }
      }
    }
  });

  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    ignoreOffline: boolean,
  ) {
    const switchingTo = yield* Ref.get(preferredRouteId);
    yield* SubscriptionRef.set(prepared, Option.none());
    const synchronizedRoutes = yield* Ref.make(0);
    const establishment = yield* Effect.raceAllFirst([
      exitUnlessInterrupted(
        establishTracedConnection(
          attempt,
          generation,
          lastFailure,
          pendingRetry,
          synchronizedRoutes,
        ),
      ).pipe(
        Effect.map((exit): EstablishmentEvent => ({
          _tag: "Completed",
          exit,
        })),
      ),
      waitForEstablishmentInterrupt().pipe(
        Effect.map((resetRetry): EstablishmentEvent => ({
          _tag: "Interrupted",
          resetRetry,
        })),
      ),
      // Each route may use the full setup time before the next is tried, and
      // each route that reaches synchronizing adds its own snapshot budget, so
      // a route that fails late does not eat the next route's time.
      Effect.gen(function* () {
        const routeCount = connectionRoutes(yield* Ref.get(currentEntry)).length;
        const startedAt = yield* Clock.monotonicTimeNanos;
        const setup = Duration.toNanosUnsafe(Duration.times(establishmentTimeout, routeCount));
        while (true) {
          const synchronized = BigInt(yield* Ref.get(synchronizedRoutes));
          const deadline =
            startedAt + setup + synchronized * Duration.toNanosUnsafe(synchronizationTimeout);
          const remaining = deadline - (yield* Clock.monotonicTimeNanos);
          if (remaining <= 0n) {
            return { _tag: "TimedOut" } as const satisfies EstablishmentEvent;
          }
          yield* Effect.sleep(Duration.nanos(remaining));
        }
      }),
    ]);

    if (establishment._tag === "Interrupted") {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
        resetRetry: establishment.resetRetry,
      } satisfies AttemptOutcome;
    }
    if (establishment._tag === "TimedOut") {
      return {
        _tag: "Failure",
        established: false,
        stable: false,
        failure: {
          error: new ConnectionTransientError({
            reason: "timeout",
            detail: setupTimeoutDetail,
          }),
          attemptSpan: Option.none(),
        },
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      const isUnexpectedDefect =
        !Cause.hasInterruptsOnly(establishment.exit.cause) &&
        !establishment.exit.cause.reasons.some(Cause.isFailReason);
      const outcome = failureFromExit(target, establishment.exit, false, false);
      if (isUnexpectedDefect) {
        const defect = establishment.exit.cause.reasons.find(Cause.isDieReason)?.defect;
        yield* Effect.logError("Connection attempt failed with an unexpected defect.").pipe(
          Effect.annotateLogs({
            "environment.id": target.environmentId,
            "environment.label": target.label,
            "cause.reason_count": establishment.exit.cause.reasons.length,
            ...safeErrorLogAttributes(defect),
          }),
        );
      }
      return outcome;
    }

    const active = establishment.exit.value;
    if (Option.isSome(switchingTo)) {
      const landed = connectionRouteId(active.lease.prepared.target);
      if (landed !== switchingTo.value) {
        const until =
          (yield* Clock.monotonicTimeNanos) + BigInt(BETTER_ROUTE_COOLDOWN_MS) * 1_000_000n;
        yield* Ref.update(routeCooldowns, (current) =>
          new Map(current).set(switchingTo.value, until),
        );
      }
    }
    const currentIntent = yield* Ref.get(intent);
    if (!currentIntent.desired || (currentIntent.network === "offline" && !ignoreOffline)) {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
        resetRetry: false,
      } satisfies AttemptOutcome;
    }

    const connectedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(prepared, Option.some(active.lease.prepared));
    yield* SubscriptionRef.set(session, Option.some(active.lease.session));
    if (options?.learnRoutes !== undefined) {
      yield* learnRoutesFrom(options.learnRoutes, active.lease).pipe(Effect.forkScoped);
    }
    yield* setState({
      desired: true,
      network: currentIntent.network,
      phase: "connected",
      stage: null,
      attempt,
      generation,
      lastFailure: null,
      retryAt: null,
    });

    const connectedExit = yield* Effect.raceFirst(
      active.lease.session.closed.pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
      monitorConnectedLease(active.lease).pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
    ).pipe(exitUnlessInterrupted);
    const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;
    if (Exit.isSuccess(connectedExit)) {
      return {
        _tag: "Interrupted",
        established: true,
        stable: connectedForMs >= BACKOFF_RESET_AFTER_MS,
        resetRetry: connectedExit.value,
      } satisfies AttemptOutcome;
    }
    const outcome = failureFromExit(
      target,
      connectedExit,
      true,
      connectedForMs >= BACKOFF_RESET_AFTER_MS,
    );
    if (outcome._tag === "Failure") {
      yield* Effect.void.pipe(
        Effect.withSpan("EnvironmentSupervisor.connectionLost", {
          root: true,
          attributes: {
            "environment.id": target.environmentId,
            "environment.label": target.label,
            "environment.target.kind": target._tag,
            "connection.connected_ms": connectedForMs,
            "connection.failure.reason": outcome.failure.error.reason,
            "connection.failure.detail": outcome.failure.error.detail,
          },
        }),
      );
    }
    return outcome;
  }, Effect.ensuring(clearLease));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - the sleep is the retry delay (false), not a timeout around the signal loop
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as(false)),
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(signals);
          switch (next._tag) {
            case "Wakeup":
              return ConnectionWakeups.resetsRetryBackoff(next.reason);
            case "ConnectRequested":
            case "DisconnectRequested":
            case "RetryRequested":
            case "NetworkChanged":
              return false;
            case "BetterRouteAvailable":
              break;
          }
        }
      }),
    );
  });

  const waitForSignal = Queue.take(signals).pipe(
    Effect.repeat({ while: (next) => next._tag === "BetterRouteAvailable" }),
    Effect.map(
      (next) => next._tag === "Wakeup" && ConnectionWakeups.resetsRetryBackoff(next.reason),
    ),
  );

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let generation = 0;
    let latestFailure: ConnectionAttemptError | null = null;
    let pendingRetry = Option.none<PendingRetryTrace>();
    const resetRetryLadder = () => {
      failureCount = 0;
      pendingRetry = Option.none();
    };
    let replacing = false;

    for (;;) {
      if (yield* Ref.getAndSet(resetRetryState, false)) {
        failureCount = 0;
        latestFailure = null;
        pendingRetry = Option.none();
      }
      const currentIntent = yield* Ref.get(intent);
      if (!currentIntent.desired) {
        resetRetryLadder();
        latestFailure = null;
        yield* clearLease;
        yield* setState(availableState(currentIntent, generation));
        yield* waitForSignal;
        continue;
      }
      if (currentIntent.network === "offline" && !replacing) {
        yield* clearLease;
        yield* setState(offlineState(currentIntent, generation, failureCount + 1, latestFailure));
        const applicationActivated = yield* waitForSignal;
        if (applicationActivated) {
          resetRetryLadder();
        }
        continue;
      }

      const attempt = failureCount + 1;
      const nextGeneration = generation + 1;
      const outcome: AttemptOutcome = yield* Effect.scoped(
        runAttempt(attempt, nextGeneration, latestFailure, pendingRetry, replacing),
      );
      replacing = false;
      const failedProbe = yield* Ref.getAndSet(probeUnanswered, false);
      if (outcome.established) {
        generation = nextGeneration;
        // A session came up, so no earlier failure describes the connection.
        // Losing a live session is not a failed connection either, for example
        // a socket the OS killed while the app was suspended: its replacement
        // reports no failure until it fails itself.
        latestFailure = null;
        if (outcome.stable) {
          resetRetryLadder();
        }
      }
      if (outcome._tag === "Interrupted") {
        if (outcome.resetRetry) {
          resetRetryLadder();
          replacing = true;
        }
        continue;
      }

      const attemptSpan: Option.Option<Tracer.Span> = outcome.failure.attemptSpan;
      const error: ConnectionAttemptError = outcome.failure.error;
      if (!outcome.established) {
        latestFailure = error;
      }
      if (error._tag === "ConnectionBlockedError") {
        const blockedIntent = yield* Ref.get(intent);
        yield* setState({
          desired: blockedIntent.desired,
          network: blockedIntent.network,
          phase: "blocked",
          stage: null,
          attempt,
          generation,
          lastFailure: error,
          retryAt: null,
        });
        const applicationActivated = yield* waitForSignal;
        if (applicationActivated) {
          resetRetryLadder();
        }
        continue;
      }

      if (failedProbe) {
        resetRetryLadder();
        yield* setState(connectingState(yield* Ref.get(intent), generation, 1, latestFailure));
        continue;
      }

      failureCount += 1;
      const delayMs = retryDelayMs(failureCount - 1, yield* Random.next);
      pendingRetry = Option.map(attemptSpan, (previousAttempt) => ({
        previousAttempt,
        failureCount,
        delayMs,
        reason: error.reason,
      }));
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt,
        generation,
        lastFailure: latestFailure,
        retryAt: (yield* Clock.currentTimeMillis) + delayMs,
      });
      const applicationActivated = yield* waitForRetrySignal(delayMs);
      if (applicationActivated) {
        resetRetryLadder();
      }
    }
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) =>
        current.network === network ? [false, current] : ([true, { ...current, network }] as const),
      ).pipe(
        Effect.flatMap((changed) =>
          changed ? signal({ _tag: "NetworkChanged", network }) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => signal({ _tag: "Wakeup", reason })),
    Effect.forkScoped,
  );
  yield* Queue.take(betterRouteChecks).pipe(
    Effect.flatMap(checkBetterRoutes),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(signal({ _tag: "ConnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal({ _tag: "DisconnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  const retryNow = Ref.set(resetRetryState, true).pipe(
    Effect.andThen(signal({ _tag: "RetryRequested" })),
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));

  return EnvironmentSupervisor.of({
    target,
    state,
    session,
    prepared,
    connect,
    disconnect,
    retryNow,
  });
});
