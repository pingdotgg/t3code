import type { RelayProtectedError } from "@t3tools/contracts/relay";
import type {
  ManagedRelayClientError,
  ManagedRelayRequestFailedError,
} from "../relay/managedRelay.ts";
import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

function connectionErrorFromRelayProtectedError(
  error: RelayProtectedError,
  cause: ManagedRelayRequestFailedError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "RelayAuthInvalidError":
    case "RelayEnvironmentLinkProofExpiredError":
    case "RelayAgentActivityPublishProofExpiredError":
    case "RelayAgentActivityPublishProofInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: error.message,
        traceId: error.traceId,
        cause,
      });
    case "RelayEnvironmentConnectNotAuthorizedError":
    case "RelayEnvironmentLinkProofInvalidError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
        traceId: error.traceId,
        cause,
      });
    case "RelayEnvironmentEndpointTimedOutError":
      return new ConnectionTransientError({
        reason: "timeout",
        detail: error.message,
        traceId: error.traceId,
        cause,
      });
    case "RelayEnvironmentEndpointUnavailableError":
    case "RelayEnvironmentLinkUnavailableError":
      return new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: error.message,
        traceId: error.traceId,
        cause,
      });
    case "RelayEnvironmentLinkFailedError":
    case "RelayInternalError":
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        detail: error.message,
        traceId: error.traceId,
        cause,
      });
  }
}

export function mapManagedRelayError(error: ManagedRelayClientError): ConnectionAttemptError {
  switch (error._tag) {
    case "ManagedRelayRequestFailedError":
      if (error.relayError) {
        return connectionErrorFromRelayProtectedError(error.relayError, error);
      }
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        detail: error.message,
        ...(error.traceId ? { traceId: error.traceId } : {}),
        cause: error,
      });
    case "ManagedRelayRequestTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        detail: error.message,
        cause: error,
      });
    case "ManagedRelayUrlInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: error.message,
        cause: error,
      });
    case "ManagedRelayAccessTokenScopesUnexpectedError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
        cause: error,
      });
    case "ManagedRelayDpopKeyLoadError":
    case "ManagedRelayTokenProofCreationError":
    case "ManagedRelayRequestProofCreationError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: error.message,
        cause: error,
      });
  }
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentAuthError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: "The environment credential is invalid.",
        traceId: error.traceId,
        cause: error,
      });
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: "The environment credential does not grant the required access.",
        traceId: error.traceId,
        cause: error,
      });
    case "EnvironmentRequestInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: "The environment rejected the authentication request.",
        traceId: error.traceId,
        cause: error,
      });
    case "RemoteEnvironmentAuthTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        detail: error.message,
        cause: error,
      });
    case "RemoteEnvironmentAuthFetchError":
      return new ConnectionTransientError({
        reason: "network",
        detail: error.message,
        cause: error,
      });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "The environment could not authorize the connection.",
        traceId: error.traceId,
        cause: error,
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: error.message,
        cause: error,
      });
  }
}
