import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
  SshConnectionTarget,
]);
export type ConnectionTarget = typeof ConnectionTarget.Type;

export const PersistedConnectionTarget = Schema.Union([
  BearerConnectionTarget,
  SshConnectionTarget,
]);
export type PersistedConnectionTarget = typeof PersistedConnectionTarget.Type;

export type NetworkStatus = "unknown" | "offline" | "online";

export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "remote-unavailable",
]);
export type ConnectionTransientReason = typeof ConnectionTransientReason.Type;

export const ConnectionBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
  "unsupported",
]);
export type ConnectionBlockedReason = typeof ConnectionBlockedReason.Type;

/** A part of the path to an environment: this device or T3 Code on the host. */
export const ConnectionHop = Schema.Literals(["device", "server"]);
export type ConnectionHop = typeof ConnectionHop.Type;

/** Causes the client can name from the errors it sees. */
export const ConnectionFailureCause = Schema.Literals(["pairing_revoked"]);
export type ConnectionFailureCause = typeof ConnectionFailureCause.Type;

/** Where and why a failure happened, when the code that saw it knows. See `presentConnectionDiagnosis`. */
const ConnectionFailureFields = {
  hop: Schema.optionalKey(ConnectionHop),
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

export interface PreparedHttpAuthorization {
  readonly _tag: "Bearer";
  readonly token: string;
}

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

export interface SupervisorConnectionState {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorConnectionPhase;
  readonly stage: ConnectionAttemptStage | null;
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly retryAt: number | null;
  /** Set once attempts have failed past the grace period; retries continue quietly. */
  readonly unreachable?: boolean;
  /** Epoch ms when a session was last live in this app run. */
  readonly lastConnectedAt?: number;
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
