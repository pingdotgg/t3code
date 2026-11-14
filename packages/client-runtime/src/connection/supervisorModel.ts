import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  type ConnectionTarget,
  ConnectionTransientError,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "./model.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { type ReportedEndpoint } from "./routes.ts";

export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 300_000;
// A cold server with a large database can take longer than 15 seconds to
// answer, and that is not a reason to drop a working connection.
export const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";
export const establishmentTimeout = Duration.fromInputUnsafe(CONNECTION_ESTABLISHMENT_TIMEOUT);
export const synchronizationTimeout = Duration.fromInputUnsafe("75 seconds");
export const CONNECTION_PROBE_TIMEOUT = "15 seconds";
export const QUICK_CONNECTION_PROBE_TIMEOUT = "3 seconds";
// A probe still unanswered this long checks the host with a fresh request. If
// the host answers while the socket stays silent, the socket is dead.
export const SILENT_SOCKET_CHECK_AFTER = "500 millis";
export const SILENT_SOCKET_RECHECK_EVERY = "1 second";
// Off the LAN one lost packet can stall a live socket for a second, so a remote
// socket must stay silent this long. It must end before
// QUICK_CONNECTION_PROBE_TIMEOUT so a long resume replaces a silent socket
// instead of timing out.
export const REMOTE_SILENT_SOCKET_AFTER = "2500 millis";
export const BACKOFF_RESET_AFTER_MS = 30_000;
export const BETTER_ROUTE_CHECK_INTERVAL_MS = 60_000;
// Each check of a dead route can wait out the full probe timeout, so a route
// that keeps failing is checked half as often each time, until the network
// changes and it may answer again.
export const SILENT_ROUTE_BACKOFF_MAX_MS = 1_800_000;
// A better route that answered the check but then failed to connect is not
// tried again for this long, so a flaky LAN cannot bounce the connection.
export const BETTER_ROUTE_COOLDOWN_MS = 300_000;

export interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

export type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup }
  | { readonly _tag: "BetterRouteAvailable"; readonly routeId: string };

export interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

export type ConnectedLease = ConnectionDriver.EnvironmentConnectionLease & {
  readonly activeRoute: ConnectionRoute | undefined;
};

export interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

export type AttemptOutcome =
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

export type EstablishmentEvent =
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

export function exitUnlessInterrupted<A, E, R>(
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

export function retryDelayMs(failureCount: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

export interface SilentRoute {
  readonly failures: number;
  readonly until: bigint;
}

export function backOffSilentRoute(previous: SilentRoute | undefined, now: bigint): SilentRoute {
  const failures = (previous?.failures ?? 0) + 1;
  const delayMs = Math.min(
    SILENT_ROUTE_BACKOFF_MAX_MS,
    BETTER_ROUTE_CHECK_INTERVAL_MS * 2 ** failures,
  );
  return { failures, until: now + BigInt(delayMs) * 1_000_000n };
}

export function annotateTarget(target: ConnectionTarget) {
  return Effect.annotateCurrentSpan({
    "environment.id": target.environmentId,
    "environment.label": target.label,
    "environment.target.kind": target._tag,
  });
}

export function availableState(
  intent: SupervisorIntent,
  generation: number,
): SupervisorConnectionState {
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

export function offlineState(
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

export function connectingState(
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

export function failureFromExit<A>(
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
