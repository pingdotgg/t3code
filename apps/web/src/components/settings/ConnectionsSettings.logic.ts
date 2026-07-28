import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { DesktopBridge, DesktopWslState, EnvironmentId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Option from "effect/Option";

/**
 * Pick the server whose pairing links and client sessions the Connections page
 * administers.
 *
 * A desktop that manages its own backend keeps administering that backend, so
 * managed mode is unchanged. A client-only desktop — or a browser pointed at a
 * saved server — has no primary, and administers the selected environment
 * instead. Access management was previously reachable only through the primary,
 * which left those clients with no way to mint a pairing link at all.
 */
export function resolveAccessEnvironment(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
}): { readonly environmentId: EnvironmentId | null; readonly isPrimary: boolean } {
  const environmentId = input.primaryEnvironmentId ?? input.activeEnvironmentId;
  return {
    environmentId,
    isPrimary: environmentId !== null && environmentId === input.primaryEnvironmentId,
  };
}

/**
 * The address to build a shareable pairing URL from for an environment the
 * desktop does not manage. Only a directly addressable HTTP origin is usable:
 * relay and SSH environments are reached through a broker or a local tunnel
 * whose address means nothing on another device, so those fall back to showing
 * the bare pairing code instead of an unusable link.
 */
export function environmentPairingBaseUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "RelayConnectionTarget":
    case "SshConnectionTarget":
      return null;
  }
}

function isShareablePairingUrl(value: string): boolean {
  let pairingUrl: URL;
  try {
    pairingUrl = new URL(value);
  } catch {
    return false;
  }
  if (isLoopbackHost(pairingUrl.hostname)) return false;

  // Hosted app links wrap the administered server's address in `host`, so the
  // outer URL can be public even when the target still resolves to the scanning
  // device itself.
  const targetUrl = pairingUrl.searchParams.get("host");
  if (targetUrl === null) return true;
  try {
    return !isLoopbackHost(new URL(targetUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Pick the pairing URL to show for a link, from the addresses that reach the
 * server being administered.
 *
 * The page's own origin is only one of those addresses when this page is served
 * by the administered server — the managed-backend case. For any other
 * environment (a saved server reached over the network, a relay, or an SSH
 * tunnel) an origin-relative link would pair the scanning device to this client
 * app instead of the server the link belongs to, so there is no shareable URL
 * and the caller falls back to showing the bare pairing code. Any loopback
 * candidate is likewise unshareable: it resolves to the scanning device, not
 * to us.
 */
export function resolveShareablePairingUrl(input: {
  /** Pairing URL for the advertised endpoint the user picked, when there is one. */
  readonly endpointPairingUrl: string | null;
  /** Pairing URL built from the administered server's own base URL. */
  readonly basePairingUrl: string | null;
  /** Pairing URL on this page's origin. */
  readonly currentOriginPairingUrl: string;
  /** Whether the administered server is the one serving this page. */
  readonly servesCurrentOrigin: boolean;
}): string | null {
  const candidates = [
    input.endpointPairingUrl,
    input.basePairingUrl,
    input.servesCurrentOrigin ? input.currentOriginPairingUrl : null,
  ];
  return (
    candidates.find((candidate) => candidate !== null && isShareablePairingUrl(candidate)) ?? null
  );
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
