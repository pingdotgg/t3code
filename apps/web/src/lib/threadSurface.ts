import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { ThreadEnvMode, UnifiedSettings } from "@t3tools/contracts";
import { resolveDefaultThreadEnvMode, type ThreadSurface } from "@t3tools/shared/threadEnvMode";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { isElectron } from "../env";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackBrowser(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(window.location.hostname.toLowerCase());
}

/**
 * Classify an environment by whether the user's attention is attached to a
 * local checkout they can see. Two conditions must both hold: the
 * environment is host-managed (the primary server or a desktop-local
 * backend, not a saved remote/relay/SSH environment), and the client itself
 * runs on that host (desktop app, or a browser served from loopback). A
 * browser reaching the primary server over LAN or a domain is detached —
 * the checkout lives on another machine the user cannot see, so isolation
 * is the only coherent default.
 */
export function resolveEnvironmentThreadSurface(
  target: ConnectionTarget | null | undefined,
): ThreadSurface {
  if (!target) {
    return "detached";
  }
  const hostManaged =
    target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
  if (!hostManaged) {
    return "detached";
  }
  return isElectron || isLoopbackBrowser() ? "attached-checkout" : "detached";
}

export function resolveSurfaceThreadEnvMode(input: {
  readonly settings: Pick<
    UnifiedSettings,
    "deriveThreadEnvModeFromSurface" | "defaultThreadEnvMode"
  >;
  readonly target: ConnectionTarget | null | undefined;
}): ThreadEnvMode {
  return resolveDefaultThreadEnvMode({
    deriveFromSurface: input.settings.deriveThreadEnvModeFromSurface,
    configuredMode: input.settings.defaultThreadEnvMode,
    surface: resolveEnvironmentThreadSurface(input.target),
  });
}
