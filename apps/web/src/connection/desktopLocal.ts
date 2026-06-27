import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopEnvironmentBootstrap } from "@t3tools/contracts";

/**
 * Desktop-local secondary backends (e.g. a parallel WSL backend) are registered
 * by the connection platform source as bearer connections whose id carries this
 * prefix. It is the renderer's single signal that an environment is a
 * host-managed local backend rather than a user-saved remote, SSH, or relay
 * environment.
 *
 * Keep this the one source of truth: the producer (`connection/platform.ts`)
 * mints ids via {@link desktopLocalConnectionId} and every consumer classifies
 * via {@link isDesktopLocalConnectionTarget}, so the convention can never drift
 * between the two.
 */
export const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function desktopLocalConnectionId(backendId: string): string {
  return `${DESKTOP_LOCAL_CONNECTION_ID_PREFIX}${backendId}`;
}

export function isDesktopLocalConnectionTarget(
  target: ConnectionTarget,
): target is Extract<ConnectionTarget, { readonly _tag: "BearerConnectionTarget" }> {
  return (
    target._tag === "BearerConnectionTarget" &&
    target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)
  );
}

export function desktopLocalBackendId(target: ConnectionTarget): string | null {
  return isDesktopLocalConnectionTarget(target)
    ? target.connectionId.slice(DESKTOP_LOCAL_CONNECTION_ID_PREFIX.length)
    : null;
}

/**
 * Read the desktop's secondary local backends (everything except the primary)
 * from the bridge. Returns an empty list off-desktop or if the bridge throws.
 * Shared by the connection platform source and the renderer's poller so both
 * read the same host topology from one place.
 */
export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const bridge = window.desktopBridge;
  if (bridge === undefined) {
    return [];
  }
  try {
    return bridge
      .getLocalEnvironmentBootstraps()
      .filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
  } catch {
    return [];
  }
}
