import type { ClientConnectionMethod, EnvironmentId } from "@t3tools/contracts";
import type { RelayProtectedError } from "@t3tools/contracts/relay";
import type { ManagedRelayClientError } from "../relay/managedRelay.ts";
import { msg } from "gt-i18n";
import { dpopFailureText, relayProtectedErrorText } from "../relay/errorPresentation.ts";
import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import {
  detailFromError,
  errorI18nMessage,
  markedTextEnglish,
  translatableDetail,
} from "../errors/translatable.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function profileMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg("Connection profile {connectionId} is unavailable.", { connectionId }),
    ),
    hop: "device",
  });
}

export function credentialMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    ...translatableDetail(
      msg("Connection credential {connectionId} is unavailable.", { connectionId }),
    ),
    hop: "device",
  });
}

/** The host itself answered and refused this device's credential, which pairing again fixes. */
export function isHostCredentialRefusal(error: ConnectionAttemptError): boolean {
  return (
    error._tag === "ConnectionBlockedError" &&
    error.hop === "server" &&
    (error.reason === "authentication" || error.reason === "permission") &&
    error.failureCause !== "clock_skew"
  );
}

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg(
        "This address now runs a different T3 Code install ({actual}, not {expected}). Remove this connection and add it again.",
        { actual: input.actual, expected: input.expected },
      ),
    ),
  });
}

function relayProtectedError(error: RelayProtectedError): ConnectionAttemptError {
  const text = relayProtectedErrorText(error);
  const detail = markedTextEnglish(text);
  const i18nMessage = text;
  const traceId = error.traceId;
  switch (error._tag) {
    case "RelayAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail,
        i18nMessage,
        traceId,
        hop: "relay",
        ...(error.dpopFailureReason === "time_window" ? { failureCause: "clock_skew" } : {}),
      });
    case "RelayEnvironmentLinkProofExpiredError":
    case "RelayAgentActivityPublishProofExpiredError":
    case "RelayAgentActivityPublishProofInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail,
        i18nMessage,
        traceId,
        hop: "relay",
      });
    case "RelayEnvironmentConnectNotAuthorizedError":
      // A host swapping in a new tunnel leaves its allocation unready until
      // the tunnel is up, and nothing on the client changes when it is.
      if (error.reason === "managed_endpoint_allocation_not_ready") {
        return new ConnectionTransientError({
          reason: "endpoint-unavailable",
          detail,
          i18nMessage,
          traceId,
          hop: "tunnel",
          failureCause: "tunnel_pending",
        });
      }
      if (error.reason === "endpoint_provider_not_managed") {
        return new ConnectionBlockedError({
          reason: "permission",
          detail,
          i18nMessage,
          traceId,
          hop: "tunnel",
          failureCause: "tunnel_not_enabled",
        });
      }
      return new ConnectionBlockedError({
        reason: "permission",
        detail,
        i18nMessage,
        traceId,
        hop: "relay",
        ...(error.reason === "environment_link_not_found" ? { failureCause: "not_linked" } : {}),
      });
    case "RelayEnvironmentLinkProofInvalidError":
    case "RelayEnvironmentLinkLimitExceededError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail,
        i18nMessage,
        traceId,
        hop: "relay",
      });
    case "RelayEnvironmentEndpointTimedOutError":
      return new ConnectionTransientError({
        reason: "timeout",
        detail,
        i18nMessage,
        traceId,
        hop: "tunnel",
        failureCause: "timeout",
      });
    case "RelayEnvironmentEndpointUnavailableError": {
      const endpointFailure =
        error.endpointFailure ??
        (error.reason === "endpoint_response_invalid" ? "invalid_response" : undefined);
      return new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail,
        i18nMessage,
        traceId,
        // The tunnel carried the request when T3 Code is what failed to answer.
        hop:
          endpointFailure === "origin_unreachable" || endpointFailure === "invalid_response"
            ? "server"
            : "tunnel",
        via: "relay",
        ...(endpointFailure ? { failureCause: endpointFailure } : {}),
        ...(error.endpointStatus ? { httpStatus: error.endpointStatus } : {}),
      });
    }
    case "RelayEnvironmentLinkUnavailableError":
      return new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail,
        i18nMessage,
        traceId,
        hop: "tunnel",
      });
    case "RelayEnvironmentLinkFailedError":
    case "RelayInternalError":
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        detail,
        i18nMessage,
        traceId,
        hop: "relay",
        failureCause: "relay_error",
      });
  }
}

export function mapManagedRelayError(error: ManagedRelayClientError): ConnectionAttemptError {
  switch (error._tag) {
    case "ManagedRelayRequestFailedError":
      if (error.relayError) {
        return relayProtectedError(error.relayError);
      }
      return new ConnectionTransientError({
        reason: "relay-unavailable",
        ...detailFromError(error),
        hop: "relay",
        // A status means the relay answered, so this device did reach it.
        ...(error.status !== undefined
          ? { httpStatus: error.status, failureCause: "relay_error" }
          : {}),
        ...(error.traceId ? { traceId: error.traceId } : {}),
      });
    case "ManagedRelayRequestTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        ...detailFromError(error),
        hop: "relay",
      });
    case "ManagedRelayUrlInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...detailFromError(error),
        hop: "relay",
      });
    case "ManagedRelayAccessTokenScopesUnexpectedError":
      return new ConnectionBlockedError({
        reason: "permission",
        ...detailFromError(error),
        hop: "relay",
      });
    case "ManagedRelayDpopKeyLoadError":
    case "ManagedRelayTokenProofCreationError":
    case "ManagedRelayRequestProofCreationError":
      return new ConnectionBlockedError({
        reason: "authentication",
        ...detailFromError(error),
        hop: "device",
      });
  }
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentAuthError,
  connectionMethod: ClientConnectionMethod = "direct",
): ConnectionAttemptError {
  const withNetworkHint = (cause: { readonly message: string }) => {
    if (connectionMethod !== "relay") return detailFromError(cause);
    const text = errorI18nMessage(cause);
    return text === undefined
      ? { detail: `${cause.message} ${NETWORK_BLOCKING_HINT}` }
      : translatableDetail(...text, NETWORK_BLOCKING_HINT);
  };
  // Over T3 Connect the relay already reached the host, so a request that never
  // arrives was blocked between this device and the tunnel.
  const unreachableHop = connectionMethod === "relay" ? "tunnel" : "server";
  const via = connectionMethod === "relay" ? "relay" : "direct";
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        ...translatableDetail(msg("The environment credential is invalid.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return new ConnectionBlockedError({
        reason: "permission",
        ...translatableDetail(
          msg("The environment credential does not grant the required access."),
        ),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "EnvironmentRequestInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...translatableDetail(msg("The environment rejected the authentication request.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "EnvironmentResourceNotFoundError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...translatableDetail(msg("The environment endpoint could not be found.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "RemoteEnvironmentAuthTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        ...withNetworkHint(error),
        hop: unreachableHop,
        via,
      });
    case "RemoteEnvironmentAuthFetchError":
      return new ConnectionTransientError({
        reason: "network",
        ...withNetworkHint(error),
        hop: unreachableHop,
        via,
      });
    case "EnvironmentConnectApprovalPendingError":
      return new ConnectionTransientError({
        reason: "approval-pending",
        ...translatableDetail(msg("This device is waiting for approval on the host.")),
        traceId: error.traceId,
        hop: "server",
        via,
        failureCause: "approval_pending",
      });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        ...translatableDetail(msg("The environment could not authorize the connection.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        ...detailFromError(error),
        hop: "server",
        via,
      });
  }
}

/**
 * An older environment server reports a DPoP clock failure as the same generic
 * invalid-credential response as other failures, so keep the compatibility hint
 * cautious when the server omits the category.
 */
export function mapRemoteDpopEnvironmentError(
  error: RemoteEnvironmentAuthError,
  connectionMethod: "relay" | "direct" = "relay",
): ConnectionAttemptError {
  if (error._tag === "EnvironmentAuthInvalidError" && error.reason === "invalid_credential") {
    return new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(
        ...dpopFailureText(msg("The environment credential is invalid."), error.dpopFailureReason),
      ),
      traceId: error.traceId,
      hop: "server",
      via: connectionMethod,
      ...(error.dpopFailureReason === "time_window" ? { failureCause: "clock_skew" } : {}),
    });
  }
  return mapRemoteEnvironmentError(error, connectionMethod);
}
