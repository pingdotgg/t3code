import { useAtomValue } from "@effect/atom-react";
import { useAuth } from "@clerk/react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentCloudLinkStateResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { RelayManagedEndpointProviderKind } from "@t3tools/contracts/relay";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { CloudEnvironmentLinkError } from "./linkEnvironment";
import { refreshManagedTunnelUsage } from "./managedRelayState";
import {
  linkEnvironment as linkEnvironmentAtom,
  unlinkEnvironment as unlinkEnvironmentAtom,
  updateEnvironmentPreferences as updateEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import { readCachedCloudLinkState, useCloudLinkState } from "./cloudLinkState";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}

// Require managed discovery: stale tunnel config after a publish-only switch causes endpoint_provider_not_managed.
function isManagedTunnelActive(
  linkState: EnvironmentCloudLinkStateResult,
  relayProviderKind: RelayManagedEndpointProviderKind | undefined,
) {
  const localManagedTunnel = linkState.managedTunnelActive ?? linkState.linked;
  return (
    linkState.linkRevoked !== true &&
    localManagedTunnel &&
    (relayProviderKind === undefined || relayProviderKind === "cloudflare_tunnel")
  );
}

const isManagedRelayRequestFailedError = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

/** The account's tunnel cap when the relay refused a new tunnel for being at it. */
function tunnelLimitFromLinkFailure(cause: unknown): number | null {
  if (!(cause instanceof CloudEnvironmentLinkError)) return null;
  const relayCause = cause.cause;
  if (!isManagedRelayRequestFailedError(relayCause)) return null;
  return relayCause.relayError?._tag === "RelayEnvironmentLinkLimitExceededError"
    ? relayCause.relayError.maxTunnels
    : null;
}

export function useCloudLinkController(environmentId: EnvironmentId | null) {
  const { getToken, isSignedIn } = useAuth();
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkEnvironment = useAtomCommand(linkEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkEnvironment = useAtomCommand(unlinkEnvironmentAtom, {
    reportFailure: false,
  });
  const updateEnvironmentPreferences = useAtomCommand(updateEnvironmentPreferencesAtom, {
    reportFailure: false,
  });
  const cloudLinkState = useCloudLinkState(environmentId);
  const relayEnvironments = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  const relayProviderKind = environmentId
    ? relayEnvironments.get(environmentId)?.environment.endpoint.providerKind
    : undefined;
  const [operationError, setOperationError] = useState<string | null>(null);
  const [tunnelLimit, setTunnelLimit] = useState<number | null>(null);

  const reportUpdateFailure = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "Could not update T3 Connect access.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not update T3 Connect", { message, traceId, cause });
    setOperationError(traceId ? `${message} Trace ID: ${traceId}` : message);
    toastManager.add({
      type: "error",
      title: "Could not update T3 Connect",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const linkData = cloudLinkState.data;
  const linkRevoked = linkData?.linkRevoked ?? false;
  const managedTunnelActive = linkData ? isManagedTunnelActive(linkData, relayProviderKind) : false;
  const managedTunnelOutOfSync =
    linkData !== null && !managedTunnelActive && isManagedTunnelActive(linkData, undefined);
  const publishAgentActivity = cloudLinkState.data?.publishAgentActivity ?? false;
  const holdWebhooksWhileOffline = cloudLinkState.data?.holdWebhooksWhileOffline ?? false;
  const linked = !linkRevoked && (cloudLinkState.data?.linked ?? false);

  const reconcileCloudState = async (desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(null);
    setTunnelLimit(null);
    const target = cloudLinkState.target;
    if (!target) {
      reportUpdateFailure(new Error("Choose an environment first."));
      return false;
    }
    const environmentId = target.environmentId;
    const canManageLink = () => {
      if (
        !readEnvironmentScope(environmentId, AuthRelayReadScope) ||
        !readEnvironmentScope(environmentId, AuthRelayWriteScope)
      ) {
        reportUpdateFailure(
          new Error("This connection needs permission to view and manage T3 Connect settings."),
        );
        return false;
      }
      return true;
    };
    const readLinkState = () => {
      const state = readCachedCloudLinkState(target);
      if (state === null) {
        reportUpdateFailure(new Error("Wait until the current T3 Connect settings can be read."));
      }
      return state;
    };
    if (!canManageLink()) return false;
    const wantsLink = desired.managedTunnel || desired.publish;
    if (wantsLink && readLinkState() === null) return false;
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (!canManageLink()) return false;

    // A failed mutation may have partially applied, so refresh server state on every exit.
    if (!wantsLink) {
      // Unlink needs no relay token; failed token reads must still allow it.
      const unlinkResult = await unlinkEnvironment({
        target,
        clerkToken: tokenResult._tag === "Success" ? (tokenResult.value ?? null) : null,
      });
      refreshManagedTunnelUsage();
      if (unlinkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(unlinkResult)) {
          reportUpdateFailure(squashAtomCommandFailure(unlinkResult));
        }
        cloudLinkState.refresh();
        return false;
      }
    } else {
      const currentLinkState = readLinkState();
      if (currentLinkState === null) return false;
      if (tokenResult._tag === "Failure") {
        reportUpdateFailure(squashAtomCommandFailure(tokenResult));
        return false;
      }
      const clerkToken = tokenResult.value;
      if (!clerkToken) {
        reportUpdateFailure(new Error("Sign in to T3 Connect before enabling this."));
        return false;
      }
      const currentManagedTunnel = isManagedTunnelActive(currentLinkState, relayProviderKind);
      if (
        !currentLinkState.linked ||
        currentLinkState.linkRevoked === true ||
        currentManagedTunnel !== desired.managedTunnel
      ) {
        const linkResult = await linkEnvironment({
          target,
          clerkToken,
          mode: desired.managedTunnel ? "managed" : "publish_only",
        });
        // Any link attempt can change the account's tunnel count.
        refreshManagedTunnelUsage();
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            const cause = squashAtomCommandFailure(linkResult);
            // The caller shows an upgrade prompt instead of an error.
            const limit = tunnelLimitFromLinkFailure(cause);
            if (limit === null) reportUpdateFailure(cause);
            else setTunnelLimit(limit);
          }
          cloudLinkState.refresh();
          return false;
        }
      }
      if (!canManageLink() || readLinkState() === null) {
        cloudLinkState.refresh();
        return false;
      }
      const prefResult = await updateEnvironmentPreferences({
        target,
        publishAgentActivity: desired.publish,
        ...(desired.holdWebhooksWhileOffline === undefined
          ? {}
          : { holdWebhooksWhileOffline: desired.holdWebhooksWhileOffline }),
      });
      if (prefResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(prefResult)) {
          reportUpdateFailure(squashAtomCommandFailure(prefResult));
        }
        cloudLinkState.refresh();
        return false;
      }
    }

    cloudLinkState.refresh();
    const refreshResult = await refreshRelayEnvironments();
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      reportUpdateFailure(squashAtomCommandFailure(refreshResult));
      return false;
    }
    return true;
  };

  return {
    isSignedIn,
    linkState: cloudLinkState,
    linked,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    tunnelLimit,
    reconcileCloudState,
  };
}
