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

export type ConnectionTargetKind = ConnectionTarget["_tag"];

export type NetworkStatus = "unknown" | "offline" | "online";

export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "relay-unavailable",
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

export const ConnectionStorageOperation = Schema.Literals([
  "open",
  "read",
  "write",
  "remove",
  "load",
  "save",
  "delete",
  "decode",
  "encode",
  "migrate",
]);
export type ConnectionStorageOperation = typeof ConnectionStorageOperation.Type;

export const ConnectionStorageBackend = Schema.Literals([
  "indexed-db",
  "desktop-secure-storage",
  "mobile-secure-storage",
  "legacy-migration",
  "schema",
]);
export type ConnectionStorageBackend = typeof ConnectionStorageBackend.Type;

export class ConnectionStorageOperationError extends Schema.TaggedErrorClass<ConnectionStorageOperationError>()(
  "ConnectionStorageOperationError",
  {
    operation: ConnectionStorageOperation,
    backend: ConnectionStorageBackend,
    storeName: Schema.optionalKey(Schema.String),
    key: Schema.optionalKey(Schema.Unknown),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} local connection data.`;
  }
}

export class IndexedDbUnavailableError extends Schema.TaggedErrorClass<IndexedDbUnavailableError>()(
  "IndexedDbUnavailableError",
  {},
) {
  override get message(): string {
    return "IndexedDB is unavailable in this browser context.";
  }
}

export class DesktopSecureStorageUnavailableError extends Schema.TaggedErrorClass<DesktopSecureStorageUnavailableError>()(
  "DesktopSecureStorageUnavailableError",
  {},
) {
  override get message(): string {
    return "Desktop secure storage is unavailable in this system context.";
  }
}

export const ConnectionStorageFailure = Schema.Union([
  ConnectionStorageOperationError,
  IndexedDbUnavailableError,
  DesktopSecureStorageUnavailableError,
]);
export type ConnectionStorageFailure = typeof ConnectionStorageFailure.Type;

export class ConnectionTransientError extends Schema.TaggedErrorClass<ConnectionTransientError>()(
  "ConnectionTransientError",
  {
    reason: ConnectionTransientReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static fromStorageFailure(cause: ConnectionStorageFailure): ConnectionTransientError {
    let detail: string;
    switch (cause._tag) {
      case "ConnectionStorageOperationError":
        detail = `Could not ${cause.operation} local connection data.`;
        break;
      case "IndexedDbUnavailableError":
        detail = "IndexedDB is unavailable in this browser context.";
        break;
      case "DesktopSecureStorageUnavailableError":
        detail = "Desktop secure storage is unavailable in this system context.";
        break;
    }
    return new ConnectionTransientError({
      reason: "remote-unavailable",
      detail,
      cause,
    });
  }

  override get message(): string {
    return this.detail;
  }
}

export class ConnectionBlockedError extends Schema.TaggedErrorClass<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: ConnectionBlockedReason,
    detail: Schema.String,
    connectionId: Schema.optionalKey(Schema.String),
    expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
    actualEnvironmentId: Schema.optionalKey(EnvironmentId),
    traceId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

export type PreparedHttpAuthorization =
  | {
      readonly _tag: "Bearer";
      readonly token: string;
    }
  | {
      readonly _tag: "Dpop";
      readonly accessToken: string;
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
