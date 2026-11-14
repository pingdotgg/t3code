import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import { type ConnectionAttemptError, ConnectionTransientError } from "./model.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { connectionRouteId, connectionRoutes } from "./routes.ts";

import {
  establishmentTimeout,
  synchronizationTimeout,
  BACKOFF_RESET_AFTER_MS,
  BETTER_ROUTE_CHECK_INTERVAL_MS,
  BETTER_ROUTE_COOLDOWN_MS,
  type SupervisorSignal,
  type PendingRetryTrace,
  type ConnectedLease,
  type TracedAttemptFailure,
  type AttemptOutcome,
  type EstablishmentEvent,
  exitUnlessInterrupted,
  retryDelayMs,
  availableState,
  offlineState,
  connectingState,
  failureFromExit,
} from "./supervisorModel.ts";
import type { makeSupervisorRuntime } from "./supervisorRuntime.ts";

type SupervisorRuntime = Effect.Success<ReturnType<typeof makeSupervisorRuntime>>;

// Stage two of the supervisor: one connection attempt and the lease monitor it
// runs while connected. The attempt loop owns the retry ladder.
export const makeSupervisorRunLoop = (runtime: SupervisorRuntime) => {
  const options = runtime.options;
  const target = runtime.target;
  const setupTimeoutDetail = runtime.setupTimeoutDetail;
  const intent = runtime.intent;
  const signals = runtime.signals;
  const resetRetryState = runtime.resetRetryState;
  const probeUnanswered = runtime.probeUnanswered;
  const session = runtime.session;
  const prepared = runtime.prepared;
  const currentEntry = runtime.currentEntry;
  const currentRoutes = runtime.currentRoutes;
  const preferredRouteId = runtime.preferredRouteId;
  const routeCooldowns = runtime.routeCooldowns;
  const learnRoutesFrom = runtime.learnRoutesFrom;
  const requestBetterRouteCheck = runtime.requestBetterRouteCheck;
  const clearLease = runtime.clearLease;
  const setState = runtime.setState;
  const establishTracedConnection = runtime.establishTracedConnection;
  const waitForEstablishmentInterrupt = runtime.waitForEstablishmentInterrupt;
  const connectedLeaseEnd = runtime.connectedLeaseEnd;
  const leaseRouteKind = runtime.leaseRouteKind;
  const isLongResume = runtime.isLongResume;
  const probeTimeoutFor = runtime.probeTimeoutFor;
  const awaitSilentSocket = runtime.awaitSilentSocket;
  const monitorConnectedLease = Effect.fnUntraced(function* (lease: ConnectedLease) {
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

    const connectedLease: ConnectedLease = {
      ...active.lease,
      activeRoute: (yield* currentRoutes).find(
        (route) =>
          connectionRouteId(route.target) === connectionRouteId(active.lease.prepared.target),
      ),
    };
    const connectedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(prepared, Option.some(connectedLease.prepared));
    yield* SubscriptionRef.set(session, Option.some(connectedLease.session));
    if (options?.learnRoutes !== undefined) {
      yield* learnRoutesFrom(options.learnRoutes, connectedLease).pipe(Effect.forkScoped);
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
      connectedLease.session.closed.pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
      monitorConnectedLease(connectedLease).pipe(
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

  return { run };
};
