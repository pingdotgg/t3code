import type { EnvironmentId } from "@t3tools/contracts";

import { isLoopbackHost } from "@t3tools/shared/preview";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

export const noop = () => undefined;

export const isLoopbackUrl = (url: string | null) =>
  url !== null && isLoopbackHost(new URL(url).hostname);

// A loopback server can receive the provider's callback itself, unless the
// desktop shell offers to catch it on the client.
export const prefersClientCallback = (local: boolean) =>
  !local || window.desktopBridge !== undefined;

/**
 * How a sign-in started now reaches the provider. Read at use time, because a
 * sign-in can start minutes after the click that asked for it (once an install
 * finishes), and the primary environment may have connected in between.
 */
export function readSignInRouting(environmentId: EnvironmentId) {
  const local = isLoopbackUrl(readPreparedConnection(environmentId)?.httpBaseUrl ?? null);
  const clientCallback = prefersClientCallback(local);
  const primaryEnvironmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const primaryAuthEnvironmentId =
    !local &&
    primaryEnvironmentId !== null &&
    appAtomRegistry.get(environmentPresentations.presentationAtom(primaryEnvironmentId))?.connection
      .phase === "connected" &&
    isLoopbackUrl(readPreparedConnection(primaryEnvironmentId)?.httpBaseUrl ?? null) &&
    (window.desktopBridge !== undefined || isLoopbackHost(window.location.hostname))
      ? primaryEnvironmentId
      : null;
  return {
    clientCallback,
    remoteWeb: clientCallback && !window.desktopBridge,
    primaryAuthEnvironmentId,
  };
}
