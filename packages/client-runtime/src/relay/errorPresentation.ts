import type { DpopFailureReason } from "@t3tools/contracts";
import {
  T3CHAT_PLAN_TUNNEL_LIMITS,
  type RelayEnvironmentStatusResponse,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { type MarkedText, resolveMarkedText } from "../errors/translatable.ts";
import { appName } from "@t3tools/shared/appName";

export const DPOP_CLOCK_HINT = msg(
  "Hint: Check that automatic date and time is enabled on both devices, then try again.",
);

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT = msg(
  "Hint: Try again. If it still fails, clock skew may be the cause; check that automatic date and time is enabled on both devices.",
);

export const DPOP_RETRY_HINT = msg("Hint: Try again. If the problem continues, copy the trace ID.");

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

export function dpopFailureText(
  message: string,
  reason: DpopFailureReason | undefined,
): MarkedText {
  return [message, dpopFailureHint(reason)];
}

/** The relay's refusal as marked sentences, for errors that carry `i18nMessage`. */
export function relayProtectedErrorText(error: RelayProtectedError): MarkedText {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return [msg("Relay rejected the cloud session token.")];
        case "invalid_dpop":
          return dpopFailureText(msg("Relay rejected the DPoP proof."), error.dpopFailureReason);
        case "not_authorized":
          return [msg("Relay rejected the authenticated request.")];
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return [msg("Relay rejected an expired environment link proof.")];
    case "RelayEnvironmentLinkProofInvalidError":
      return [
        msg("Relay rejected the environment link proof ({reason}).", { reason: error.reason }),
      ];
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return [
          msg(
            "Relay has no active link for this environment. If it was deregistered from T3 Connect, link it again on that machine.",
          ),
        ];
      }
      if (error.reason === "managed_endpoint_allocation_not_ready") {
        return [msg("The environment's T3 Connect tunnel is still being set up.")];
      }
      if (error.reason === "endpoint_provider_not_managed") {
        return [
          msg(
            "This environment is linked only to publish agent activity, so it cannot accept connections. On that computer, open Settings > Sharing & access and turn T3 Connect on.",
          ),
        ];
      }
      return error.reason
        ? [
            msg("Relay rejected the environment connection request ({reason}).", {
              reason: error.reason,
            }),
          ]
        : [msg("Relay rejected the environment connection request.")];
    case "RelayEnvironmentEndpointUnavailableError":
      return [
        msg("Relay could not reach the environment endpoint ({reason}).", { reason: error.reason }),
      ];
    case "RelayEnvironmentEndpointTimedOutError":
      return [msg("Relay timed out while contacting the environment endpoint.")];
    case "RelayEnvironmentLinkFailedError":
      return [msg("Relay could not link the environment ({reason}).", { reason: error.reason })];
    case "RelayEnvironmentLinkUnavailableError":
      return error.provisioningStage
        ? [
            msg("Relay cannot provision the managed endpoint ({reason}). Failed stage: {stage}.", {
              reason: error.reason,
              stage: error.provisioningStage,
            }),
          ]
        : [
            msg("Relay cannot provision the managed endpoint ({reason}).", {
              reason: error.reason,
            }),
          ];
    case "RelayEnvironmentLinkLimitExceededError":
      return error.maxTunnels < T3CHAT_PLAN_TUNNEL_LIMITS.premier
        ? [
            msg(
              "Relay refused the link: this account already has its maximum of {maxTunnels} managed tunnels. Unlink an environment, or link a paid T3 Chat account in your T3 Connect account settings on web or desktop. Pro raises the default limit to {pro} and Premier to {premier}.",
              {
                maxTunnels: error.maxTunnels,
                pro: T3CHAT_PLAN_TUNNEL_LIMITS.pro,
                premier: T3CHAT_PLAN_TUNNEL_LIMITS.premier,
              },
            ),
          ]
        : [
            msg(
              "Relay refused the link: this account already has its maximum of {maxTunnels} managed tunnels. Unlink an environment to free one up.",
              { maxTunnels: error.maxTunnels },
            ),
          ];
    case "RelayAgentActivityPublishProofExpiredError":
      return [msg("Relay rejected an expired agent activity publish proof.")];
    case "RelayAgentActivityPublishProofInvalidError":
      return [
        msg("Relay rejected the agent activity publish proof ({reason}).", {
          reason: error.reason,
        }),
      ];
    case "RelayInternalError":
      return [msg("Relay encountered an internal error ({reason}).", { reason: error.reason })];
  }
}

export function relayProtectedErrorMessage(
  error: RelayProtectedError,
  resolve: MFunctionType = mFallback,
): string {
  return resolveMarkedText(relayProtectedErrorText(error), resolve);
}

// The relay cuts off a request it cannot finish in time with a 504 that no
// endpoint declares, so the client sees only the status.
export const RELAY_GATEWAY_TIMEOUT_MESSAGE = msg(
  "Relay timed out before it finished the request (HTTP 504). Try again in a few minutes. If it keeps failing, copy the trace ID when you report it.",
);

export function relayRequestFailureText(error: {
  readonly relayError?: RelayProtectedError | undefined;
  readonly status?: number | undefined;
}): MarkedText | null {
  if (error.relayError) return relayProtectedErrorText(error.relayError);
  if (error.status === 504) return [RELAY_GATEWAY_TIMEOUT_MESSAGE];
  if (error.status !== undefined)
    return [msg("Relay returned an unexpected HTTP {status}.", { status: error.status })];
  return null;
}

export function relayRequestFailureDetail(
  error: {
    readonly relayError?: RelayProtectedError | undefined;
    readonly status?: number | undefined;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const text = relayRequestFailureText(error);
  return text === null ? null : resolveMarkedText(text, resolve);
}

export function relayOfflineReasonMessage(
  status: Pick<RelayEnvironmentStatusResponse, "offlineReason">,
  resolve: MFunctionType = mFallback,
): string | null {
  switch (status.offlineReason) {
    case "tunnel_released":
      return resolve(
        msg(
          "Offline for a while, so its T3 Connect tunnel was removed. Start {appName} on that computer and update it to the latest version to reconnect.",
          { appName: appName() },
        ),
      );
    case undefined:
      return null;
  }
}
