import { useAtomValue } from "@effect/atom-react";
import { useAuth } from "@clerk/react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  EnvironmentId,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentCloudLinkStateResult,
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
import { stackedThreadToast } from "../components/ui/toastHelpers";
import { relayEnvironmentDiscovery } from "../state/relay";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { CloudEnvironmentLinkError } from "./linkEnvironment";
import { refreshManagedTunnelUsage } from "./managedRelayState";
import {
  linkPrimaryEnvironment as linkPrimaryEnvironmentAtom,
  unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom,
  updatePrimaryEnvironmentPreferences as updatePrimaryEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import { readCachedPrimaryCloudLinkState, usePrimaryCloudLinkState } from "./primaryCloudLinkState";
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

export function useCloudLinkController() {
  const { getToken, isSignedIn } = useAuth();
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const updatePrimaryEnvironmentPreferences = useAtomCommand(
    updatePrimaryEnvironmentPreferencesAtom,
    { reportFailure: false },
  );
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const relayEnvironments = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  const primaryEnvironmentId = primaryCloudLinkState.target?.environmentId;
  const relayProviderKind = primaryEnvironmentId
    ? relayEnvironments.get(primaryEnvironmentId)?.environment.endpoint.providerKind
    : undefined;
  const [operationError, setOperationError] = useState<string | null>(null);
  const [tunnelLimit, setTunnelLimit] = useState<number | null>(null);

  const reportUpdateFailure = (
    cause: unknown,
    description = "Could not save this change. Try again.",
  ) => {
    const message = cause instanceof Error ? cause.message : "Could not update T3 Connect access.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not update T3 Connect", { message, traceId, cause });
    setOperationError(traceId ? `${message} Trace ID: ${traceId}` : message);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not update T3 Connect",
        description,
        ...(traceId
          ? {
              actionProps: {
                children: "Copy trace ID",
                onClick: () => void navigator.clipboard?.writeText(traceId),
              },
            }
          : {}),
        actionVariant: "outline",
        data: {
          copyErrorText: message,
          expandableContent: message,
          expandableLabels: { expand: "Show more", collapse: "Show less" },
        },
      }),
    );
  };

  const linkData = primaryCloudLinkState.data;
  const linkRevoked = linkData?.linkRevoked ?? false;
  const managedTunnelActive = linkData ? isManagedTunnelActive(linkData, relayProviderKind) : false;
  const managedTunnelOutOfSync =
    linkData !== null && !managedTunnelActive && isManagedTunnelActive(linkData, undefined);
  const publishAgentActivity = primaryCloudLinkState.data?.publishAgentActivity ?? false;
  const holdWebhooksWhileOffline = primaryCloudLinkState.data?.holdWebhooksWhileOffline ?? false;
  const linked = !linkRevoked && (primaryCloudLinkState.data?.linked ?? false);

  const reconcileCloudState = async (desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(null);
    setTunnelLimit(null);
    const target = primaryCloudLinkState.target;
    if (!target) {
      reportUpdateFailure(new Error("Local environment is not ready yet."));
      return false;
    }
    const environmentId = EnvironmentId.make(target.environmentId);
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
      const state = readCachedPrimaryCloudLinkState(target);
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
      const unlinkResult = await unlinkPrimaryEnvironment({
        target,
        clerkToken: tokenResult._tag === "Success" ? (tokenResult.value ?? null) : null,
      });
      refreshManagedTunnelUsage();
      if (unlinkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(unlinkResult)) {
          reportUpdateFailure(
            squashAtomCommandFailure(unlinkResult),
            "Could not finish disconnecting. Try again.",
          );
        }
        primaryCloudLinkState.refresh();
        await refreshRelayEnvironments();
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
        const linkResult = await linkPrimaryEnvironment({
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
          primaryCloudLinkState.refresh();
          return false;
        }
      }
      if (!canManageLink() || readLinkState() === null) {
        primaryCloudLinkState.refresh();
        return false;
      }
      const prefResult = await updatePrimaryEnvironmentPreferences({
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
        primaryCloudLinkState.refresh();
        return false;
      }
    }

    primaryCloudLinkState.refresh();
    const refreshResult = await refreshRelayEnvironments();
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      reportUpdateFailure(squashAtomCommandFailure(refreshResult));
      return false;
    }
    return true;
  };

  return {
    isSignedIn,
    linkState: primaryCloudLinkState,
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
