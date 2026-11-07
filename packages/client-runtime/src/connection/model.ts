import { EnvironmentId } from "@t3tools/contracts";
import { RelayEnvironmentEndpointFailure } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { withGatewayTicket } from "../environment/endpoint.ts";

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
    };

export interface PreparedConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly target: ConnectionTarget;
  /** On a LAN gateway route, mints the short-lived ticket a request needs to pass the gateway. */
  readonly gatewayTicket?: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
}

/** The base URL for one request: a gateway route's ticket expires, so `httpBaseUrl` holds none. */
export const ticketedHttpBaseUrl = (
  prepared: PreparedConnection,
): Effect.Effect<string, ConnectionAttemptError> =>
  prepared.gatewayTicket === undefined
    ? Effect.succeed(prepared.httpBaseUrl)
    : prepared.gatewayTicket.pipe(
        Effect.map((ticket) => withGatewayTicket(prepared.httpBaseUrl, ticket)),
      );

/**
 * `<img>` and uploads cannot set headers, so a server-issued URL carries a gateway route's ticket.
 * Returns the same object on any other route.
 */
export const ticketedRelativeUrl = <A extends { readonly relativeUrl: string }>(
  prepared: Option.Option<PreparedConnection>,
  value: A,
): Effect.Effect<A, ConnectionAttemptError> =>
  Option.isNone(prepared) || prepared.value.gatewayTicket === undefined
    ? Effect.succeed(value)
    : prepared.value.gatewayTicket.pipe(
        Effect.map((ticket) =>
          Option.isNone(ticket)
            ? value
            : { ...value, relativeUrl: withGatewayTicket(value.relativeUrl, ticket) },
        ),
      );

export type SupervisorConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "backoff"
  | "connected"
  | "blocked";

export type ConnectionAttemptStage = "preparing" | "opening" | "synchronizing";

export interface SupervisorConnectionState {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorConnectionPhase;
  readonly stage: ConnectionAttemptStage | null;
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly retryAt: number | null;
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
});
