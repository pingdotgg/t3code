import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
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
import * as Semaphore from "effect/Semaphore";
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
  NO_REFUSED_ROUTES,
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
  insertRoute,
  type ReportedEndpoint,
} from "./routes.ts";

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
const SESSION_LOSS_RETRY_DELAY_MS = 250;
// Someone is approving this device on the host; check back soon rather than climbing the ladder.
const APPROVAL_PENDING_RETRY_DELAY_MS = 4_000;
// A request lives 10 minutes; past that nobody is approving, so a forgotten device backs off.
const APPROVAL_PENDING_FAST_RETRIES = 150;
// A cold server with a large database can take longer than 15 seconds to
// answer, and that is not a reason to drop a working connection.
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";
const establishmentTimeout = Duration.fromInputUnsafe(CONNECTION_ESTABLISHMENT_TIMEOUT);
const synchronizationTimeout = Duration.fromInputUnsafe("75 seconds");
const CONNECTION_PROBE_TIMEOUT = "15 seconds";
const QUICK_CONNECTION_PROBE_TIMEOUT = "3 seconds";
// After a long suspension pooled connections are often dead too, so the host
// check can hang with the socket. A replacement is cheaper than the wait.
const LONG_RESUME_PROBE_TIMEOUT = "1500 millis";
// A probe still unanswered this long checks the host with a fresh request. If
// the host answers while the socket stays silent, the socket is dead.
const SILENT_SOCKET_CHECK_AFTER = "500 millis";
const SILENT_SOCKET_RECHECK_EVERY = "1 second";
const FRAME_CHECK_EVERY = "100 millis";
// Off the LAN one lost packet can stall a live socket for a second, so a remote
// socket must stay silent this long, except after a long resume. It must end
// before QUICK_CONNECTION_PROBE_TIMEOUT so a resume replaces a silent socket
// instead of timing out.
const REMOTE_SILENT_SOCKET_AFTER = "2500 millis";
const BACKOFF_RESET_AFTER_MS = 30_000;
const BETTER_ROUTE_CHECK_INTERVAL_MS = 60_000;
// Each check of a dead route can wait out the full probe timeout, so a route
// that keeps failing is checked half as often each time, until the network
// changes and it may answer again.
const SILENT_ROUTE_BACKOFF_MAX_MS = 1_800_000;
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
  | { readonly _tag: "BetterRouteAvailable"; readonly routeId: string }
  | { readonly _tag: "ReplacementReady"; readonly replacement: Replacement };

interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

type ConnectedLease = ConnectionDriver.EnvironmentConnectionLease & {
  readonly activeRoute: ConnectionRoute | undefined;
  readonly generation: number;
};

function mergeRefusedRoutes(
  known: ReadonlyArray<string>,
  refused: ReadonlyArray<string>,
  keep: (routeId: string) => boolean,
): ReadonlyArray<string> {
  const next = [...new Set([...known, ...refused])].filter(keep);
  return next.length === known.length && next.every((id, index) => id === known[index])
    ? known
    : next;
}

interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

interface EstablishedLease {
  readonly attemptSpan: Option.Option<Tracer.Span>;
  readonly lease: ConnectionDriver.EnvironmentConnectionLease;
}

// A connection opened beside a live session, so the session can move to it
// without passing through disconnected. Its progress stays hidden until the
// old session ends and it becomes the visible attempt.
interface Replacement {
  readonly fiber: Fiber.Fiber<EstablishedLease, TracedAttemptFailure>;
  readonly scope: Scope.Closeable;
  readonly startedAt: bigint;
  readonly synchronizedRoutes: Ref.Ref<number>;
  readonly upgradeTo: Option.Option<string>;
  // The live socket's frame count when a suspect replacement started.
  readonly liveFrames: Option.Option<number>;
  readonly reveal: Effect.Effect<void>;
}

interface Handoff {
  readonly replacement: Replacement;
  readonly ready: Option.Option<EstablishedLease>;
}

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
      readonly handoff?: Handoff;
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
      readonly exit: Exit.Exit<EstablishedLease, TracedAttemptFailure>;
    }
  | { readonly _tag: "Interrupted"; readonly resetRetry: boolean }
  | { readonly _tag: "TimedOut" };

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

interface SilentRoute {
  readonly failures: number;
  readonly until: bigint;
}

function backOffSilentRoute(previous: SilentRoute | undefined, now: bigint): SilentRoute {
  const failures = (previous?.failures ?? 0) + 1;
  const delayMs = Math.min(
    SILENT_ROUTE_BACKOFF_MAX_MS,
    BETTER_ROUTE_CHECK_INTERVAL_MS * 2 ** failures,
  );
  return { failures, until: now + BigInt(delayMs) * 1_000_000n };
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
    refusedRouteIds: NO_REFUSED_ROUTES,
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
    refusedRouteIds: NO_REFUSED_ROUTES,
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
    refusedRouteIds: NO_REFUSED_ROUTES,
  };
}

function failureFromCause(
  target: ConnectionTarget,
  cause: Cause.Cause<TracedAttemptFailure>,
  established: boolean,
  stable: boolean,
) {
  return {
    _tag: "Failure",
    established,
    stable,
    failure: cause.reasons.find(Cause.isFailReason)?.error ?? unexpectedFailure(target),
  } satisfies AttemptOutcome;
}

function unexpectedFailure(target: ConnectionTarget): TracedAttemptFailure {
  return {
    error: new ConnectionTransientError({
      reason: "transport",
      ...translatableDetail(msg("{host} connection failed unexpectedly.", { host: target.label })),
    }),
    attemptSpan: Option.none(),
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
  const setupTimeout = msg("{host} did not respond during connection setup.", {
    host: target.label,
  });
  const setupTimeoutDetail = usesRelay
    ? translatableDetail(setupTimeout, NETWORK_BLOCKING_HINT)
    : translatableDetail(setupTimeout);
  yield* annotateTarget(target);

  const supervisorScope = yield* Scope.Scope;
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
  const pendingReplacement = yield* Ref.make(Option.none<Replacement>());
  const replacementLock = yield* Semaphore.make(1);
  const routeCooldowns = yield* Ref.make<ReadonlyMap<string, bigint>>(new Map());
  // Outlives sessions so a reconnect shows a refusal seen earlier; a route leaves once it connects.
  const refusedRoutes = yield* Ref.make(NO_REFUSED_ROUTES);
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

  const attemptEntry = Effect.fnUntraced(function* (upgradeTo: Option.Option<string>) {
    const latest = yield* Ref.get(currentEntry);
    const routes = connectionRoutes(latest);
    if (Option.isNone(upgradeTo)) return latest;
    const route = routes.find(
      (candidate) => connectionRouteId(candidate.target) === upgradeTo.value,
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

  const routeRank = (routeId: string) =>
    currentRoutes.pipe(
      Effect.map((routes) =>
        routes.findIndex((route) => connectionRouteId(route.target) === routeId),
      ),
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
    const live = yield* SubscriptionRef.get(session);
    if (Option.isNone(live) || live.value !== lease.session) return;
    const refused = better
      .filter((_route, position) => results[position] === "refused")
      .map((route) => connectionRouteId(route.target));
    if (refused.length > 0) {
      const known = yield* Ref.updateAndGet(refusedRoutes, (current) =>
        mergeRefusedRoutes(current, refused, () => true),
      );
      yield* SubscriptionRef.updateSome(state, (current) =>
        current.phase === "connected" &&
        current.generation === lease.generation &&
        current.refusedRouteIds !== known
          ? Option.some({ ...current, refusedRouteIds: known })
          : Option.none(),
      );
    }
    const index = results.indexOf("ready");
    if (index === -1) return;
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

  // Every session change restarts each subscription, so an unchanged session
  // is not published again.
  const setLease = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    const current = yield* SubscriptionRef.get(session);
    if (Option.isSome(current) && current.value === lease.session) return;
    yield* SubscriptionRef.set(prepared, Option.some(lease.prepared));
    yield* SubscriptionRef.set(session, Option.some(lease.session));
  });

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

  const logUnexpectedFailure = (
    failed: "attempt" | "release" | "loop",
    cause: Cause.Cause<TracedAttemptFailure>,
  ) => {
    const died = cause.reasons.find(Cause.isDieReason);
    if (!died && cause.reasons.some(Cause.isFailReason)) return Effect.void;
    return Effect.logError(
      `Connection ${failed} failed with an unexpected ${died ? "defect" : "interruption"}.`,
    ).pipe(
      Effect.annotateLogs({
        "environment.id": target.environmentId,
        "environment.label": target.label,
        "cause.reason_count": cause.reasons.length,
        ...(died ? safeErrorLogAttributes(died.defect) : {}),
      }),
    );
  };

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    nextGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if ("prepared" in progress) {
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }
    yield* setState(
      connectingState(yield* Ref.get(intent), nextGeneration, attempt, lastFailure, progress.stage),
    );
  });

  type ProgressReporter = (
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) => Effect.Effect<void>;

  const countingSynchronized =
    (synchronizedRoutes: Ref.Ref<number>, report: ProgressReporter): ProgressReporter =>
    (progress) =>
      (progress.stage === "synchronizing"
        ? Ref.update(synchronizedRoutes, (count) => count + 1)
        : Effect.void
      ).pipe(Effect.andThen(report(progress)));

  const establishConnection = Effect.fnUntraced(function* (
    preferredRoute: Option.Option<string>,
    report: ProgressReporter,
  ) {
    return yield* driver.connect(yield* attemptEntry(preferredRoute), report);
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
    nextGeneration: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) => {
    // The span must end with the ConnectionAttemptError itself: the exporter
    // can only describe an Error-like failure, and a TracedAttemptFailure
    // wrapper reached it as "[object Object]". The wrapper is added outside.
    let attemptSpan = Option.none<Tracer.Span>();
    const traced = Effect.gen(function* () {
      attemptSpan = Option.some(yield* Effect.currentSpan.pipe(Effect.orDie));
      yield* Effect.annotateCurrentSpan({
        "environment.id": target.environmentId,
        "environment.target.kind": target._tag,
        "connection.attempt": attempt,
        "connection.generation": nextGeneration,
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
    nextGeneration: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
    preferredRoute: Option.Option<string>,
    report: ProgressReporter,
  ) {
    if (usesRelay) {
      return yield* traceRelayEstablishment(
        establishConnection(preferredRoute, report),
        attempt,
        nextGeneration,
        pendingRetry,
      );
    }
    return yield* establishConnection(preferredRoute, report).pipe(
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

  // The fiber stops before its sockets close, so a discarded replacement ends
  // interrupted instead of failed.
  const closeReplacement = (replacement: Replacement) =>
    Fiber.interrupt(replacement.fiber).pipe(
      Effect.ensuring(Scope.close(replacement.scope, Exit.void)),
    );

  // Whoever takes the pending replacement owns it: it either connects over it
  // or closes it.
  const discardReplacement = (when: (replacement: Replacement) => boolean = () => true) =>
    Effect.uninterruptible(
      Ref.modify(
        pendingReplacement,
        (current): readonly [Option.Option<Replacement>, Option.Option<Replacement>] =>
          Option.isSome(current) && when(current.value)
            ? [current, Option.none()]
            : [Option.none(), current],
      ).pipe(
        Effect.tap((taken) => (Option.isSome(taken) ? closeReplacement(taken.value) : Effect.void)),
      ),
    );

  const discardSuspectReplacement = discardReplacement((replacement) =>
    Option.isNone(replacement.upgradeTo),
  );

  const takeHandoff = Effect.gen(function* () {
    const taken = yield* Ref.getAndSet(pendingReplacement, Option.none());
    if (Option.isNone(taken)) return Option.none<Handoff>();
    const replacement = taken.value;
    const exit = replacement.fiber.pollUnsafe();
    if (exit !== undefined && Exit.isSuccess(exit)) {
      return Option.some<Handoff>({ replacement, ready: Option.some(exit.value) });
    }
    if (exit !== undefined || (yield* replacementExpired(replacement))) {
      yield* closeReplacement(replacement);
      return Option.none<Handoff>();
    }
    return Option.some<Handoff>({ replacement, ready: Option.none() });
  });

  const coolDownRoute = Effect.fnUntraced(function* (routeId: string) {
    const until = (yield* Clock.monotonicTimeNanos) + BigInt(BETTER_ROUTE_COOLDOWN_MS) * 1_000_000n;
    yield* Ref.update(routeCooldowns, (current) => new Map(current).set(routeId, until));
  });

  const settleReplacement = Effect.fn("EnvironmentSupervisor.settleReplacement")(function* (
    replacement: Replacement,
    exit: Exit.Exit<EstablishedLease, TracedAttemptFailure>,
  ) {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
    const landedOn = Exit.isSuccess(exit)
      ? connectionRouteId(exit.value.lease.prepared.target)
      : undefined;
    const usable = Option.match(replacement.upgradeTo, {
      onNone: () => landedOn !== undefined,
      onSome: (routeId) => routeId === landedOn,
    });
    if (usable) {
      return yield* signal({ _tag: "ReplacementReady", replacement });
    }
    if (Option.isSome(replacement.upgradeTo)) yield* coolDownRoute(replacement.upgradeTo.value);
    yield* discardReplacement((current) => current === replacement);
  });

  // Each route may use the full setup time before the next is tried, and
  // each route that reaches synchronizing adds its own snapshot budget, so
  // a route that fails late does not eat the next route's time. Untraced: it
  // is a calculation rerun on every deadline wake.
  const setupBudget = Effect.fnUntraced(function* (synchronizedRoutes: Ref.Ref<number>) {
    const routeCount = connectionRoutes(yield* Ref.get(currentEntry)).length;
    const synchronized = BigInt(yield* Ref.get(synchronizedRoutes));
    return (
      Duration.toNanosUnsafe(Duration.times(establishmentTimeout, routeCount)) +
      synchronized * Duration.toNanosUnsafe(synchronizationTimeout)
    );
  });

  // A hidden replacement has no timer of its own; past its setup budget it
  // is stale, so it is neither adopted nor allowed to block a new one.
  const replacementExpired = (replacement: Replacement) =>
    Effect.all([setupBudget(replacement.synchronizedRoutes), Clock.monotonicTimeNanos]).pipe(
      Effect.map(([budget, now]) => now - replacement.startedAt >= budget),
    );

  // `generation` is the live session's; the replacement reports progress as
  // the first attempt of the next one, which it becomes if the session ends.
  const startReplacement = Effect.fn("EnvironmentSupervisor.startReplacement")(
    function* (generation: number, upgradeTo: Option.Option<string>, live?: ConnectedLease) {
      const pending = yield* Ref.get(pendingReplacement);
      if (Option.isSome(pending)) {
        if (!(yield* replacementExpired(pending.value))) return;
        yield* discardReplacement();
        // A better route that answered its check but stalled waits like one
        // that failed, instead of a new stalled connection every minute.
        const stalledUpgrade = pending.value.upgradeTo;
        if (Option.isSome(stalledUpgrade)) {
          yield* coolDownRoute(stalledUpgrade.value);
          if (Option.contains(upgradeTo, stalledUpgrade.value)) return;
        }
      }
      const startedAt = yield* Clock.monotonicTimeNanos;
      const scope = yield* Scope.fork(supervisorScope);
      const synchronizedRoutes = yield* Ref.make(0);
      const lock = yield* Semaphore.make(1);
      let visible = false;
      let latest: ConnectionDriver.ConnectionDriverProgress | undefined;
      const report: ProgressReporter = (progress) =>
        lock.withPermit(
          Effect.suspend(() => {
            latest = progress;
            return visible ? reportProgress(1, generation + 1, null, progress) : Effect.void;
          }),
        );
      const reveal = lock.withPermit(
        Effect.suspend(() => {
          visible = true;
          return latest === undefined
            ? Effect.void
            : reportProgress(1, generation + 1, null, latest);
        }),
      );
      const fiber = yield* establishTracedConnection(
        1,
        generation + 1,
        Option.none(),
        upgradeTo,
        countingSynchronized(synchronizedRoutes, report),
      ).pipe(Scope.provide(scope), Effect.forkIn(scope));
      const replacement: Replacement = {
        fiber,
        scope,
        startedAt,
        synchronizedRoutes,
        upgradeTo,
        liveFrames:
          live === undefined || Option.isSome(upgradeTo)
            ? Option.none()
            : Option.some(yield* live.session.inboundFrames),
        reveal,
      };
      yield* Ref.set(pendingReplacement, Option.some(replacement));
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit) => settleReplacement(replacement, exit)),
        Effect.forkIn(supervisorScope),
      );
    },
    // The lock makes check-then-set atomic for concurrent callers, and an
    // interrupted caller cannot leave behind a scope that nothing owns.
    (effect) => replacementLock.withPermit(effect),
    Effect.uninterruptible,
  );

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* (ignoreOffline: boolean) {
    // A primary attempt keeps running through an offline report, so the
    // network returning restarts it in case it stalled meanwhile.
    let deviceOffline = (yield* connectivity.status) === "offline";
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
          return false;
        case "RetryRequested":
          // Once the loop has taken this retry's flag, the running attempt is
          // the one the retry asked for.
          if (yield* Ref.get(resetRetryState)) {
            return false;
          }
          break;
        case "NetworkChanged":
          if (target._tag !== "PrimaryConnectionTarget") {
            if (next.network === "offline" && !ignoreOffline) {
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
        case "ReplacementReady":
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
    lease: ConnectedLease,
    generation: number,
  ): Effect.fn.Return<"end" | "replace" | undefined> {
    if (next._tag === "DisconnectRequested") {
      return "end" as const;
    }
    // A check queued before the session moved can name a route that is no
    // longer better than the live one.
    if (next._tag === "BetterRouteAvailable") {
      const rank = yield* routeRank(next.routeId);
      if (rank === -1 || rank >= (yield* routeIndex(lease))) return undefined;
      yield* discardSuspectReplacement;
      yield* startReplacement(generation, Option.some(next.routeId));
      return undefined;
    }
    // The attempt that owns the lease takes the replacement once the monitor
    // has stopped, so a close racing this signal cannot strand it.
    if (next._tag === "ReplacementReady") {
      const pending = yield* Ref.get(pendingReplacement);
      if (Option.isNone(pending) || pending.value !== next.replacement) return undefined;
      // A frame since it started shows the socket alive, even between frame checks.
      const liveFrames = next.replacement.liveFrames;
      if (Option.isSome(liveFrames) && (yield* lease.session.inboundFrames) !== liveFrames.value) {
        yield* discardSuspectReplacement;
        return undefined;
      }
      // One on a worse route waits as the fallback in case the socket is dead.
      const exit = next.replacement.fiber.pollUnsafe();
      if (Option.isNone(next.replacement.upgradeTo) && exit !== undefined && Exit.isSuccess(exit)) {
        const rank = yield* routeRank(connectionRouteId(exit.value.lease.prepared.target));
        if (rank > (yield* routeIndex(lease))) return undefined;
      }
      return "replace";
    }
    if (next._tag === "Wakeup" && next.reason === "credentials-changed") {
      // A replacement may have been prepared with the old account.
      yield* discardReplacement();
      // Only a session over T3 Connect holds the old account's credential.
      if (isRelayLease(lease)) {
        yield* logManagedRelayAccountChange;
        return "end" as const;
      }
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
          return LONG_RESUME_PROBE_TIMEOUT;
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
      case "ReplacementReady":
        return undefined;
    }
  };

  const isForegroundProbe = (next: SupervisorSignal) =>
    next._tag === "Wakeup" && next.reason === "application-active";

  // Ends "silent" when the host answers a fresh request while the socket
  // delivers nothing, as when iOS kills a suspended socket without a close
  // event, and "alive" once the socket delivers a frame. A slow or
  // unreachable host never ends it.
  const awaitSilentSocket = Effect.fn("EnvironmentSupervisor.awaitSilentSocket")(function* (
    lease: ConnectedLease,
    routeKind: ConnectionRouteKind | undefined,
    longResume: boolean,
    onHostAnswered: Effect.Effect<void>,
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
    // The session only counts frames, so a host check slower than the probe
    // deadline would otherwise hide a frame until after the socket is replaced.
    const frameArrives = Effect.sleep(FRAME_CHECK_EVERY).pipe(
      Effect.andThen(socketSilent),
      Effect.repeat({ while: (silent) => silent }),
      Effect.as("alive" as const),
    );
    const hostAnswersWhileSilent = Effect.gen(function* () {
      // A radio still waking up or a stale pooled connection can fail one check.
      while ((yield* driver.checkHost(lease.prepared)) !== "answered") {
        yield* Effect.sleep(SILENT_SOCKET_RECHECK_EVERY);
      }
      if (!(yield* socketSilent)) return "alive" as const;
      // The host takes fresh requests, so a replacement starts connecting now.
      // It takes over as soon as it connects; a frame before then keeps the socket.
      yield* onHostAnswered;
      if (!answersQuickly(routeKind) && !longResume) {
        const silentFor = (yield* Clock.monotonicTimeNanos) - startedAt;
        const remaining = Duration.toNanosUnsafe(REMOTE_SILENT_SOCKET_AFTER) - silentFor;
        if (remaining > 0n) yield* Effect.sleep(Duration.nanos(remaining));
      }
      return (yield* socketSilent) ? ("silent" as const) : ("alive" as const);
    });
    return yield* Effect.race(hostAnswersWhileSilent, frameArrives);
  });

  // Returning to the app, a retry, or an offline report (often wrong, as for a
  // loopback server) probes the live session instead of tearing it down. Ends
  // with true when the session should move to a replacement or a fresh attempt.
  const monitorConnectedLease = Effect.fnUntraced(function* (
    lease: ConnectedLease,
    generation: number,
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
    yield* Stream.tick(Duration.millis(BETTER_ROUTE_CHECK_INTERVAL_MS)).pipe(
      Stream.drop(1),
      Stream.runForEach(() => requestBetterRouteCheck(lease)),
      Effect.forkScoped,
    );
    const routeKind = yield* leaseRouteKind(lease);
    for (;;) {
      const next = yield* takeSignal;
      const end = yield* connectedLeaseEnd(next, lease, generation);
      if (end !== undefined) {
        return end === "replace";
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
      let probe = yield* Effect.forkChild(lease.session.probe);
      // A busy server can miss one foreground probe while the socket is still
      // healthy, so the first miss asks again and only the follow-up's miss
      // replaces the session.
      let toleratesMiss = isForegroundProbe(next);
      let silentSocket: Fiber.Fiber<"silent" | "alive"> | undefined;
      // A signal during a running check, such as a network change that kills
      // the socket, needs a fresh check only if the running one sees a frame.
      let recheck = false;
      let longResume = isLongResume(next);
      const startSilentSocketCheck = Effect.gen(function* () {
        silentSocket = yield* Effect.forkChild(
          awaitSilentSocket(
            lease,
            routeKind,
            longResume,
            startReplacement(generation, Option.none(), lease),
          ),
        );
        recheck = false;
      });
      // A long suspension or a changed network path restarts a replacement
      // that may have stalled with the app or on the old path. A path change
      // can also strand the socket's own route (leaving the LAN), so it starts
      // a replacement over whichever route answers now.
      const startProbeReplacement = (signal: SupervisorSignal) => {
        const pathChanged =
          signal._tag === "Wakeup" &&
          signal.reason === "network-changed" &&
          routeKind !== "loopback";
        if (!pathChanged && !isLongResume(signal)) return Effect.void;
        return discardReplacement().pipe(
          Effect.flatMap((taken) =>
            Option.isSome(taken) || pathChanged
              ? startReplacement(
                  generation,
                  Option.flatMap(taken, (replacement) => replacement.upgradeTo),
                  lease,
                )
              : Effect.void,
          ),
        );
      };
      // The web and desktop foreground probe allows a busy host 15 seconds,
      // and a busy host can answer a fresh request before a queued probe.
      const armSilentSocketCheck = Effect.fnUntraced(function* (signal: SupervisorSignal) {
        if (isForegroundProbe(signal)) return;
        if (silentSocket !== undefined) {
          recheck = true;
          return;
        }
        yield* startSilentSocketCheck;
      });
      yield* startProbeReplacement(next);
      yield* armSilentSocketCheck(next);
      const stopProbe = Effect.suspend(() =>
        Effect.all(
          [Fiber.interrupt(probe), silentSocket ? Fiber.interrupt(silentSocket) : Effect.void],
          { discard: true },
        ),
      );
      let longResumeStartedAt = yield* Clock.monotonicTimeNanos;
      let deadline = longResumeStartedAt + Duration.toNanosUnsafe(probeTimeout);
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
          yield* discardSuspectReplacement;
          // A frame shows the socket still works, so its probe gets the usual resume time.
          if (longResume) {
            const aliveDeadline =
              longResumeStartedAt + Duration.toNanosUnsafe(QUICK_CONNECTION_PROBE_TIMEOUT);
            if (aliveDeadline > deadline) deadline = aliveDeadline;
          }
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
          if (toleratesMiss) {
            toleratesMiss = false;
            yield* Fiber.interrupt(probe);
            probe = yield* Effect.forkChild(lease.session.probe);
            deadline = (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(probeTimeout);
            continue;
          }
          yield* stopProbe;
          // A long suspension leaves the socket suspect even when the network
          // reports offline, so it is replaced like a silent one.
          if (longResume) return true;
          return yield* new ConnectionTransientError({
            reason: "timeout",
            ...translatableDetail(
              msg("{host} did not respond to a connection health check.", {
                host: target.label,
              }),
            ),
          });
        }
        if (probeEvent._tag === "ProbeCompleted") {
          if (silentSocket) yield* Fiber.interrupt(silentSocket);
          if (Exit.isSuccess(probeEvent.exit)) {
            yield* Ref.set(probeUnanswered, false);
            yield* discardSuspectReplacement;
          }
          yield* probeEvent.exit;
          break;
        }
        const endDuringProbe = yield* connectedLeaseEnd(probeEvent.signal, lease, generation);
        if (endDuringProbe !== undefined) {
          yield* stopProbe;
          return endDuringProbe === "replace";
        }
        const signalTimeout = probeTimeoutFor(probeEvent.signal, routeKind);
        if (signalTimeout !== undefined) {
          // A retry or network signal wants a definite answer, even when its
          // own deadline lands after the foreground one.
          if (!isForegroundProbe(probeEvent.signal)) toleratesMiss = false;
          if (isLongResume(probeEvent.signal) && !longResume) {
            longResume = true;
            longResumeStartedAt = yield* Clock.monotonicTimeNanos;
          }
          yield* startProbeReplacement(probeEvent.signal);
          yield* armSilentSocketCheck(probeEvent.signal);
          const signalDeadline =
            (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(signalTimeout);
          if (signalDeadline < deadline) deadline = signalDeadline;
        }
      }
    }
  });

  // Moving straight to a connected replacement keeps the session from reading
  // as disconnected between the two.
  const endAttempt = Effect.fn("EnvironmentSupervisor.endAttempt")(function* (
    exit: Exit.Exit<AttemptOutcome>,
  ) {
    const ready =
      Exit.isSuccess(exit) && exit.value._tag === "Interrupted"
        ? exit.value.handoff?.ready
        : undefined;
    // A disconnect that raced the handoff must not flash the new session.
    if (ready !== undefined && Option.isSome(ready) && (yield* Ref.get(intent)).desired) {
      return yield* setLease(ready.value.lease);
    }
    yield* clearLease;
  });

  // Advanced as a session goes live and kept across loop restarts, so no two sessions share one.
  let generation = 0;
  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    nextGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    ignoreOffline: boolean,
    handoff: Option.Option<Handoff>,
  ) {
    let establish: Effect.Effect<EstablishedLease, TracedAttemptFailure, Scope.Scope>;
    let synchronizedRoutes: Ref.Ref<number>;
    let startedAt = yield* Clock.monotonicTimeNanos;
    const ready = Option.flatMap(handoff, (value) => value.ready);
    if (Option.isSome(handoff)) {
      const { replacement } = handoff.value;
      yield* Effect.addFinalizer(() => closeReplacement(replacement));
      synchronizedRoutes = replacement.synchronizedRoutes;
      startedAt = replacement.startedAt;
      if (Option.isNone(ready)) yield* replacement.reveal;
      establish = Fiber.join(replacement.fiber);
    } else {
      yield* SubscriptionRef.set(prepared, Option.none());
      synchronizedRoutes = yield* Ref.make(0);
      establish = establishTracedConnection(
        attempt,
        nextGeneration,
        pendingRetry,
        Option.none(),
        countingSynchronized(synchronizedRoutes, (progress) =>
          reportProgress(attempt, nextGeneration, lastFailure, progress),
        ),
      );
    }
    const raceEstablishment = Effect.raceAllFirst([
      Effect.exit(establish).pipe(
        Effect.map((exit): EstablishmentEvent => ({
          _tag: "Completed",
          exit,
        })),
      ),
      waitForEstablishmentInterrupt(ignoreOffline).pipe(
        Effect.map((resetRetry): EstablishmentEvent => ({
          _tag: "Interrupted",
          resetRetry,
        })),
      ),
      Effect.gen(function* () {
        const routes = connectionRoutes(yield* Ref.get(currentEntry));
        // The desktop bounds SSH preparation, which may download a server
        // release, so for SSH-only entries the clock stops while preparing.
        const pausesWhilePreparing = routes.every((route) => connectionRouteKind(route) === "ssh");
        const preparing = (expected: boolean) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filter((current) => (current.stage === "preparing") === expected),
            Stream.runHead,
          );
        // An adopted replacement has already used part of its budget.
        let spent = (yield* Clock.monotonicTimeNanos) - startedAt;
        while (true) {
          if (pausesWhilePreparing) yield* preparing(false);
          const remaining = (yield* setupBudget(synchronizedRoutes)) - spent;
          if (remaining <= 0n) {
            return { _tag: "TimedOut" } as const satisfies EstablishmentEvent;
          }
          const resumedAt = yield* Clock.monotonicTimeNanos;
          const sleep = Effect.sleep(Duration.nanos(remaining));
          yield* pausesWhilePreparing ? Effect.raceFirst(sleep, preparing(true)) : sleep;
          spent += (yield* Clock.monotonicTimeNanos) - resumedAt;
        }
      }),
    ]);
    // A connected replacement already holds the session, so a queued signal
    // must not interrupt adopting it.
    const establishment: EstablishmentEvent = Option.isSome(ready)
      ? { _tag: "Completed", exit: Exit.succeed(ready.value) }
      : yield* raceEstablishment;

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
            ...setupTimeoutDetail,
          }),
          attemptSpan: Option.none(),
        },
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      yield* logUnexpectedFailure("attempt", establishment.exit.cause);
      return failureFromCause(target, establishment.exit.cause, false, false);
    }

    const active = establishment.exit.value;
    const currentIntent = yield* Ref.get(intent);
    if (!currentIntent.desired || (currentIntent.network === "offline" && !ignoreOffline)) {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
        resetRetry: false,
      } satisfies AttemptOutcome;
    }

    const routes = yield* currentRoutes;
    const activeRouteId = connectionRouteId(active.lease.prepared.target);
    const connectedLease: ConnectedLease = {
      ...active.lease,
      activeRoute: routes.find((route) => connectionRouteId(route.target) === activeRouteId),
      generation: nextGeneration,
    };
    const refusedRouteIds = yield* Ref.updateAndGet(refusedRoutes, (known) =>
      mergeRefusedRoutes(
        known,
        active.lease.refusedRouteIds,
        (id) =>
          id !== activeRouteId && routes.some((route) => connectionRouteId(route.target) === id),
      ),
    );
    const connectedAt = yield* Clock.currentTimeMillis;
    generation = nextGeneration;
    yield* setLease(connectedLease);
    if (options?.learnRoutes !== undefined) {
      yield* learnRoutesFrom(options.learnRoutes, connectedLease).pipe(Effect.forkScoped);
    }
    yield* setState({
      desired: true,
      network: currentIntent.network,
      phase: "connected",
      stage: null,
      attempt,
      generation: nextGeneration,
      lastFailure: null,
      retryAt: null,
      refusedRouteIds,
    });

    const connectedExit = yield* Effect.raceFirst(
      connectedLease.session.closed.pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
      monitorConnectedLease(connectedLease, nextGeneration).pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
    ).pipe(Effect.exit);
    const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;
    const stable = connectedForMs >= BACKOFF_RESET_AFTER_MS;
    if (Exit.isSuccess(connectedExit)) {
      if (!connectedExit.value) {
        yield* discardReplacement();
        return {
          _tag: "Interrupted",
          established: true,
          stable,
          resetRetry: false,
        } satisfies AttemptOutcome;
      }
      const next = Option.getOrUndefined(yield* takeHandoff);
      return {
        _tag: "Interrupted",
        established: true,
        stable,
        resetRetry: true,
        ...(next === undefined ? {} : { handoff: next }),
      } satisfies AttemptOutcome;
    }
    yield* logUnexpectedFailure("attempt", connectedExit.cause);
    const outcome = failureFromCause(target, connectedExit.cause, true, stable);
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
    // A replacement already opening becomes the reconnect attempt.
    const next = yield* takeHandoff;
    if (Option.isSome(next)) {
      return {
        _tag: "Interrupted",
        established: true,
        stable,
        resetRetry: true,
        handoff: next.value,
      } satisfies AttemptOutcome;
    }
    return outcome;
  }, Effect.onExit(endAttempt));

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
            case "ReplacementReady":
              break;
          }
        }
      }),
    );
  });

  const waitForSignal = Effect.gen(function* () {
    for (;;) {
      const next = yield* Queue.take(signals);
      if (next._tag === "BetterRouteAvailable" || next._tag === "ReplacementReady") continue;
      return next._tag === "Wakeup" && ConnectionWakeups.resetsRetryBackoff(next.reason);
    }
  });

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    // Approval waits count as attempts but not toward backoff, so a later outage starts low.
    let backoffFailures = 0;
    let approvalWaits = 0;
    let latestFailure: ConnectionAttemptError | null = null;
    let pendingRetry = Option.none<PendingRetryTrace>();
    const resetRetryLadder = () => {
      failureCount = 0;
      backoffFailures = 0;
      approvalWaits = 0;
      pendingRetry = Option.none();
    };
    let replacing = false;
    let handoff = Option.none<Handoff>();

    for (;;) {
      const retryRequested = yield* Ref.getAndSet(resetRetryState, false);
      if (retryRequested) {
        failureCount = 0;
        backoffFailures = 0;
        approvalWaits = 0;
        latestFailure = null;
        pendingRetry = Option.none();
      }
      const currentIntent = yield* Ref.get(intent);
      if (!currentIntent.desired) {
        if (Option.isSome(handoff)) yield* closeReplacement(handoff.value.replacement);
        handoff = Option.none();
        resetRetryLadder();
        latestFailure = null;
        yield* clearLease;
        yield* setState(availableState(currentIntent, generation));
        yield* waitForSignal;
        continue;
      }
      // The platform's offline report can stay wrong after the network is back,
      // so an explicit retry still tries instead of waiting for it to change.
      const ignoreOffline = replacing || retryRequested;
      if (currentIntent.network === "offline" && !ignoreOffline) {
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
      const outcome: AttemptOutcome = yield* Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          runAttempt(
            attempt,
            nextGeneration,
            latestFailure,
            pendingRetry,
            ignoreOffline,
            handoff,
          ).pipe(
            Scope.provide(scope),
            Effect.catchCause((cause) =>
              logUnexpectedFailure("attempt", cause).pipe(
                Effect.as(failureFromCause(target, cause, generation === nextGeneration, false)),
              ),
            ),
          ),
        (scope, exit) =>
          Scope.close(scope, exit).pipe(
            Effect.catchCause((cause) => logUnexpectedFailure("release", cause)),
          ),
      );
      replacing = false;
      handoff = Option.none();
      const failedProbe = yield* Ref.getAndSet(probeUnanswered, false);
      if (outcome.established) {
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
          handoff = Option.fromUndefinedOr(outcome.handoff);
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
          refusedRouteIds: NO_REFUSED_ROUTES,
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

      // The first loss of a live session retries almost at once; the ladder
      // still counts it, so a host that keeps dropping sessions backs off.
      const firstLoss = outcome.established && failureCount === 0;
      failureCount += 1;
      if (error.reason === "approval-pending") approvalWaits += 1;
      const awaitingApproval =
        error.reason === "approval-pending" && approvalWaits <= APPROVAL_PENDING_FAST_RETRIES;
      if (!awaitingApproval) backoffFailures += 1;
      const delayMs = awaitingApproval
        ? APPROVAL_PENDING_RETRY_DELAY_MS
        : firstLoss
          ? Math.round(SESSION_LOSS_RETRY_DELAY_MS * (0.5 + (yield* Random.next) / 2))
          : error.reason === "approval-pending"
            ? Math.max(
                APPROVAL_PENDING_RETRY_DELAY_MS,
                retryDelayMs(backoffFailures - 1, yield* Random.next),
              )
            : retryDelayMs(backoffFailures - 1, yield* Random.next);
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
        refusedRouteIds: NO_REFUSED_ROUTES,
      });
      const applicationActivated = yield* waitForRetrySignal(delayMs);
      if (applicationActivated) {
        resetRetryLadder();
      }
    }
  });

  // Registered before the fibers below so closing the scope interrupts them first.
  // A loop still running when the queue shuts down would report that as a failure.
  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));
  // A defect in a background listener would otherwise end it for good, silently.
  // Untraced: a span here would stay open for the supervisor's whole lifetime.
  const keepRunning = Effect.fnUntraced(
    function* (task: string, effect: Effect.Effect<void>, onRestart?: Effect.Effect<void>) {
      let current = effect;
      while (true) {
        const exit = yield* Effect.exit(current);
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
        yield* Effect.logError("Connection supervisor task failed; restarting it.").pipe(
          Effect.annotateLogs({
            "environment.id": target.environmentId,
            "environment.label": target.label,
            task,
            ...safeErrorLogAttributes(exit.cause.reasons.find(Cause.isDieReason)?.defect),
          }),
        );
        yield* Effect.sleep(RETRY_BASE_DELAY_MS);
        current = onRestart ? onRestart.pipe(Effect.andThen(effect)) : effect;
      }
    },
    (self) => Effect.forkScoped(self),
  );

  const applyNetwork = (network: NetworkStatus) =>
    Ref.modify(intent, (current) => {
      const next = targetNetwork(network);
      return current.network === next
        ? [false, current]
        : ([true, { ...current, network: next }] as const);
    }).pipe(
      Effect.flatMap((changed) =>
        changed
          ? (network === "offline" ? Effect.void : forgetSilentRoutes).pipe(
              Effect.andThen(signal({ _tag: "NetworkChanged", network })),
            )
          : Effect.void,
      ),
    );
  // A restarted listener may have missed changes while it was down.
  yield* keepRunning(
    "network-listener",
    connectivity.changes.pipe(Stream.runForEach(applyNetwork)),
    connectivity.status.pipe(Effect.flatMap(applyNetwork)),
  );
  yield* keepRunning(
    "wakeup-listener",
    wakeups.changes.pipe(
      Stream.filter(ConnectionWakeups.reachesConnectionSupervisor),
      Stream.runForEach((reason) =>
        // A long suspension can hide a network change the platform never reported.
        (reason === "network-changed" || reason === "application-active-long"
          ? forgetSilentRoutes
          : Effect.void
        ).pipe(Effect.andThen(signal({ _tag: "Wakeup", reason }))),
      ),
    ),
  );
  yield* keepRunning(
    "better-route-checker",
    Queue.take(betterRouteChecks).pipe(Effect.flatMap(checkBetterRoutes), Effect.forever),
  );
  // A restarted loop has forgotten its retry ladder, so it waits out the
  // ladder's ceiling unless a signal cuts the wait short.
  yield* run().pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* logUnexpectedFailure("loop", cause);
        const currentIntent = yield* Ref.get(intent);
        const lastFailure = unexpectedFailure(target).error;
        yield* setState(
          !currentIntent.desired
            ? availableState(currentIntent, generation)
            : currentIntent.network === "offline"
              ? offlineState(currentIntent, generation, 1, lastFailure)
              : {
                  desired: true,
                  network: currentIntent.network,
                  phase: "backoff",
                  stage: null,
                  attempt: 1,
                  generation,
                  lastFailure,
                  retryAt: (yield* Clock.currentTimeMillis) + RETRY_MAX_DELAY_MS,
                  refusedRouteIds: NO_REFUSED_ROUTES,
                },
        );
        yield* waitForRetrySignal(RETRY_MAX_DELAY_MS);
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

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
