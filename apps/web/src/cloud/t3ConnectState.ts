import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import type {
  RelayManagedEndpoint,
  RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";

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

// The URL ends up in commands people paste into a shell, so only plain DNS names pass.
const TUNNEL_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * An environment's MCP URL on its T3 Connect tunnel, or null. This machine reports its own
 * tunnel hostname; a saved machine's comes from T3 Connect, and only a tunnel counts there,
 * since a publish-only link registers its local address as `manual`.
 */
export function t3ConnectMcpUrl(input: {
  readonly thisMachine: boolean;
  readonly tunnelHostname: string | undefined;
  readonly relayEndpoint: RelayManagedEndpoint | undefined;
}): string | null {
  const url = input.thisMachine
    ? URL.parse(`https://${input.tunnelHostname ?? ""}`)
    : input.relayEndpoint?.providerKind === "cloudflare_tunnel"
      ? URL.parse(input.relayEndpoint.httpBaseUrl)
      : null;
  return url?.protocol === "https:" && TUNNEL_HOSTNAME.test(url.hostname)
    ? `${url.origin}/mcp`
    : null;
}

/** Where T3 Connect can be turned on for an environment: from here, only by policy, or on its host. */
export type T3ConnectTurnOn =
  | { readonly kind: "here" }
  | { readonly kind: "policy"; readonly reason: string }
  | { readonly kind: "on-host" };

/**
 * Settings and the MCP wizard share this, so a Turn on control shows only where linking works.
 * `linkableHere` is the environment's own answer for this session (its link state).
 */
export function resolveT3ConnectTurnOn(input: {
  readonly desktopApp: boolean;
  readonly linkableHere: boolean;
  readonly cloudConfigured: boolean;
  readonly canReadRelay: boolean;
  readonly canWriteRelay: boolean;
  readonly connectDenial: string | undefined;
}): T3ConnectTurnOn {
  if (input.connectDenial !== undefined) return { kind: "policy", reason: input.connectDenial };
  return input.desktopApp &&
    input.linkableHere &&
    input.cloudConfigured &&
    input.canReadRelay &&
    input.canWriteRelay
    ? { kind: "here" }
    : { kind: "on-host" };
}
