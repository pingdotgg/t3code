import { useAuth } from "@clerk/react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { linkPrimaryEnvironment as linkPrimaryEnvironmentAtom } from "../../cloud/linkEnvironmentAtoms";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import {
  desktopManagedTunnelOriginReconcileKey,
  startDesktopManagedTunnelOriginReconcile,
} from "../../cloud/reconcileDesktopManagedTunnelOrigin";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * UI-linked desktop environments record the loopback origin only at link time.
 * After a restart the embedded backend can land on a different port; re-link
 * with the current origin so T3 Connect ingress follows.
 */
export function DesktopManagedTunnelOriginReconcile() {
  if (!hasCloudPublicConfig() || window.desktopBridge === undefined) return null;
  return <ConfiguredDesktopManagedTunnelOriginReconcile />;
}

/** Re-registers the desktop managed tunnel with the current loopback origin after a port hop. */
function ConfiguredDesktopManagedTunnelOriginReconcile() {
  const { getToken, isLoaded, isSignedIn } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const linkState = usePrimaryCloudLinkState();
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const latestRef = useRef({ getToken, linkPrimaryEnvironment, target: linkState.target });
  useEffect(() => {
    latestRef.current = { getToken, linkPrimaryEnvironment, target: linkState.target };
  });

  const key =
    !isLoaded || !isSignedIn || linkState.data === null
      ? null
      : desktopManagedTunnelOriginReconcileKey({
          signedIn: true,
          target: linkState.target,
          linked: linkState.data.linked ?? false,
          managedTunnelActive: linkState.data.managedTunnelActive ?? linkState.data.linked ?? false,
        });

  useEffect(() => {
    if (key === null) return;
    // Key the session on the loopback origin so callback identity and SWR
    // object churn cannot cancel a pending backoff or reset the attempt bound.
    return startDesktopManagedTunnelOriginReconcile({
      runAttempt: async (isCancelled) => {
        const { getToken, linkPrimaryEnvironment, target } = latestRef.current;
        if (target === null) return "failure";
        const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
        if (isCancelled()) return "failure";
        if (tokenResult._tag === "Failure") {
          logReconcileFailure(squashAtomCommandFailure(tokenResult));
          return "failure";
        }
        const clerkToken = tokenResult.value;
        if (!clerkToken) return "failure";
        const linkResult = await linkPrimaryEnvironment({
          target,
          clerkToken,
          mode: "managed",
          installRelayClient: false,
        });
        if (isCancelled()) return "failure";
        if (linkResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(linkResult)) {
            logReconcileFailure(squashAtomCommandFailure(linkResult));
          }
          return "failure";
        }
        return "success";
      },
    });
  }, [key]);

  return null;
}

/** Warns when desktop origin re-registration fails. */
function logReconcileFailure(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const traceId = findErrorTraceId(cause);
  console.warn("[t3-connect] Could not re-register the desktop environment origin", {
    message,
    traceId,
    cause,
  });
}
