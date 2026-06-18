import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayProtectedError } from "@t3tools/contracts/relay";
import type { ManagedRelayClientError } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function profileMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    message: `Connection profile ${connectionId} is unavailable.`,
  });
}

export function credentialMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    message: `Connection credential ${connectionId} is unavailable.`,
  });
}

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    message: `Connected environment ${input.actual} does not match ${input.expected}.`,
  });
}

function relayProtectedError(error: RelayProtectedError): ConnectionAttemptError {
  switch (error._tag) {
    case "RelayAuthInvalidError":
    case "RelayEnvironmentLinkProofExpiredError":
    case "RelayAgentActivityPublishProofExpiredError":
    case "RelayAgentActivityPublishProofInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        message: error.message,
        traceId: error.traceId,
      });
    case "RelayEnvironmentConnectNotAuthorizedError":
    case "RelayEnvironmentLinkProofInvalidError":
      return new ConnectionBlockedError({
        reason: "permission",
        message: error.message,
        traceId: error.traceId,
      });
    case "RelayEnvironmentEndpointTimedOutError":
      return new ConnectionTransientError({
        reason: "timeout",
        message: error.message,
        traceId: error.traceId,
      });
    case "RelayEnvironmentEndpointUnavailableError":
    case "RelayEnvironmentLinkUnavailableError":
      return new ConnectionTransientError({
        reason: "endpoint-unavailable",
        message: error.message,
        traceId: error.traceId,
      });
    case "RelayEnvironmentLinkFailedError":
    case "RelayInternalError":
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        message: error.message,
        traceId: error.traceId,
      });
  }
}

export function mapManagedRelayError(error: ManagedRelayClientError): ConnectionAttemptError {
  if (error.relayError) {
    return relayProtectedError(error.relayError);
  }
  if (error.cause?._tag === "ManagedRelayRequestTimeoutError") {
    return new ConnectionTransientError({
      reason: "timeout",
      message: error.message,
      ...(error.traceId ? { traceId: error.traceId } : {}),
    });
  }
  return new ConnectionTransientError({
    reason: "relay-unavailable",
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
  });
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentAuthError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        message: "The environment credential is invalid.",
        traceId: error.traceId,
      });
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return new ConnectionBlockedError({
        reason: "permission",
        message: "The environment credential does not grant the required access.",
        traceId: error.traceId,
      });
    case "EnvironmentRequestInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        message: "The environment rejected the authentication request.",
        traceId: error.traceId,
      });
    case "RemoteEnvironmentAuthTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        message: error.message,
      });
    case "RemoteEnvironmentAuthFetchError":
      return new ConnectionTransientError({
        reason: "network",
        message: error.message,
      });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        message: "The environment could not authorize the connection.",
        traceId: error.traceId,
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        message: error.message,
      });
  }
}
