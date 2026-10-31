import { EnvironmentId, TailnetSignInRefusedReason } from "@t3tools/contracts";
import { RelayEnvironmentEndpointFailure } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

import type { ConnectionRouteKind } from "./routes.ts";

const ConnectionTargetBase = {
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class PrimaryConnectionTarget extends Schema.TaggedClass<PrimaryConnectionTarget>()(
  "PrimaryConnectionTarget",
  {
    ...ConnectionTargetBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export class BearerConnectionTarget extends Schema.TaggedClass<BearerConnectionTarget>()(
  "BearerConnectionTarget",
  {
    ...ConnectionTargetBase,
    connectionId: Schema.String,
  },
) {}

export class RelayConnectionTarget extends Schema.TaggedClass<RelayConnectionTarget>()(
  "RelayConnectionTarget",
  {
    ...ConnectionTargetBase,
  },
) {}

export class SshConnectionTarget extends Schema.TaggedClass<SshConnectionTarget>()(
  "SshConnectionTarget",
  {
    ...ConnectionTargetBase,
    connectionId: Schema.String,
  },
) {}

export const ConnectionTarget = Schema.Union([
  PrimaryConnectionTarget,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
]);
export type ConnectionTarget = typeof ConnectionTarget.Type;

export const PersistedConnectionTarget = Schema.Union([
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
]);
export type PersistedConnectionTarget = typeof PersistedConnectionTarget.Type;

export type NetworkStatus = "unknown" | "offline" | "online";

export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "relay-unavailable",
  "remote-unavailable",
  "session-pending",
]);
export type ConnectionTransientReason = typeof ConnectionTransientReason.Type;

export const ConnectionBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
  "unsupported",
]);
export type ConnectionBlockedReason = typeof ConnectionBlockedReason.Type;

/** A part of the path to an environment: this device, T3 Connect, the host's tunnel, or T3 Code on the host. */
export const ConnectionHop = Schema.Literals(["device", "relay", "tunnel", "server"]);
export type ConnectionHop = typeof ConnectionHop.Type;

/** The relay's endpoint failures plus the causes the client can name from other errors. */
export const ConnectionFailureCause = Schema.Literals([
  ...RelayEnvironmentEndpointFailure.literals,
  "clock_skew",
  "not_linked",
  "relay_error",
  "tunnel_pending",
  "tunnel_not_enabled",
]);
export type ConnectionFailureCause = typeof ConnectionFailureCause.Type;

/**
 * Where and why a failure happened, when the code that saw it knows. See
 * `presentConnectionDiagnosis`. `via` names the route when the hop alone does
 * not: T3 Code on the host can fail behind the tunnel or on a direct route.
 */
const ConnectionFailureFields = {
  hop: Schema.optionalKey(ConnectionHop),
  via: Schema.optionalKey(Schema.Literals(["relay", "direct"])),
  failureCause: Schema.optionalKey(ConnectionFailureCause),
  httpStatus: Schema.optionalKey(Schema.Number),
  /** The check a host's Tailscale sign-in failed. */
  tailnetRefusal: Schema.optionalKey(TailnetSignInRefusedReason),
  /** The tailnet policy grant the host says would let this device in. */
  suggestedGrant: Schema.optionalKey(Schema.String),
};

export class ConnectionTransientError extends Schema.TaggedError<ConnectionTransientError>()(
  "ConnectionTransientError",
  {
    reason: ConnectionTransientReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
    ...ConnectionFailureFields,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ConnectionBlockedError extends Schema.TaggedError<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: ConnectionBlockedReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
    ...ConnectionFailureFields,

    serverUpdateRequired: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

export const DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export type PreparedHttpAuthorization =
  | {
      readonly _tag: "Bearer";
      readonly token: string;
    }
  | {
      readonly _tag: "Dpop";
      readonly accessToken: string;
      readonly expiresAtEpochMs: number;
      /** Set for a Tailscale session, which renews from this credential instead of T3 Connect. */
      readonly tailnetCredentialId?: string;
    };

export interface PreparedConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly target: ConnectionTarget;
}

export type SupervisorConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "backoff"
  | "connected"
  | "blocked";

export type ConnectionAttemptStage = "preparing" | "opening" | "synchronizing";

/**
 * What the latest attempt saw on one route: the host answered there, did not
 * answer the reachability check, or the connection over it failed.
 */
export type ConnectionRouteOutcome = {
  readonly routeId: string;
  readonly kind: ConnectionRouteKind;
  readonly address: string | null;
} & (
  | { readonly result: "answered" | "silent" }
  | { readonly result: "failed"; readonly error: ConnectionAttemptError }
);

const UNANSWERED_REASONS: ReadonlySet<ConnectionTransientReason> = new Set([
  "network",
  "timeout",
  "transport",
]);

/** A failure that gave no sign the host is there, as opposed to one where it answered. */
export function failureDidNotAnswer(error: ConnectionAttemptError): boolean {
  return (
    error._tag === "ConnectionTransientError" &&
    UNANSWERED_REASONS.has(error.reason) &&
    error.tailnetRefusal === undefined
  );
}

/** A route that gave no sign the host is there, as opposed to one that answered and refused. */
export function routeDidNotAnswer(outcome: ConnectionRouteOutcome): boolean {
  return (
    outcome.result === "silent" ||
    (outcome.result === "failed" && failureDidNotAnswer(outcome.error))
  );
}

export interface SupervisorConnectionState {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorConnectionPhase;
  readonly stage: ConnectionAttemptStage | null;
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly retryAt: number | null;
  /** Each route's latest outcome. A route keeps it until an attempt reaches that route again. */
  readonly routes: ReadonlyArray<ConnectionRouteOutcome>;
}

export type ConnectionProjectionPhase = "disconnected" | "synchronizing" | "ready";

export function connectionProjectionPhase(
  state: SupervisorConnectionState,
): ConnectionProjectionPhase {
  switch (state.phase) {
    case "connecting":
      return "synchronizing";
    case "connected":
      return "ready";
    case "available":
    case "offline":
    case "backoff":
    case "blocked":
      return "disconnected";
  }
}

export const AVAILABLE_CONNECTION_STATE: SupervisorConnectionState = Object.freeze({
  desired: false,
  network: "unknown",
  phase: "available",
  stage: null,
  attempt: 0,
  generation: 0,
  lastFailure: null,
  retryAt: null,
  routes: [],
});
