import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import type {
  RelayManagedEndpoint,
  RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";

// Require managed discovery: stale tunnel config after a publish-only switch causes endpoint_provider_not_managed.
export function isManagedTunnelActive(
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

/**
 * The environment's MCP URL on its T3 Connect tunnel, or null. A publish-only link registers
 * its local address as `manual`, which is never public, so only a tunnel address counts.
 */
export function t3ConnectMcpUrl(
  linkState: Pick<EnvironmentCloudLinkStateResult, "tunnelHostname">,
  relayEndpoint: RelayManagedEndpoint | undefined,
): string | null {
  const base = linkState.tunnelHostname
    ? `https://${linkState.tunnelHostname}`
    : relayEndpoint?.providerKind === "cloudflare_tunnel"
      ? relayEndpoint.httpBaseUrl
      : null;
  const url = base === null ? null : URL.parse(base);
  return url?.protocol === "https:" ? `${url.origin}/mcp` : null;
}

/**
 * Backends this desktop app started sign in with its bootstrap credential, and the server lets
 * that session link to T3 Connect from any address, a WSL distro's IP too. A backend reached
 * over the network does not qualify, even on this machine.
 */
export function isDesktopOwnBackend(
  target: ConnectionTarget,
  primaryIsDesktopManaged: boolean,
): boolean {
  return target._tag === "PrimaryConnectionTarget"
    ? primaryIsDesktopManaged
    : isDesktopLocalConnectionTarget(target);
}

/** Where T3 Connect can be turned on for an environment: from here, only by policy, or on its host. */
export type T3ConnectTurnOn =
  | { readonly kind: "here" }
  | { readonly kind: "policy"; readonly reason: string }
  | { readonly kind: "on-host" };

/** Settings and the MCP wizard share this, so a Turn on control shows only where linking works. */
export function resolveT3ConnectTurnOn(input: {
  readonly desktopApp: boolean;
  readonly ownBackend: boolean;
  readonly cloudConfigured: boolean;
  readonly canReadRelay: boolean;
  readonly canWriteRelay: boolean;
  readonly connectDenial: string | undefined;
}): T3ConnectTurnOn {
  if (input.connectDenial !== undefined) return { kind: "policy", reason: input.connectDenial };
  return input.desktopApp &&
    input.ownBackend &&
    input.cloudConfigured &&
    input.canReadRelay &&
    input.canWriteRelay
    ? { kind: "here" }
    : { kind: "on-host" };
}
