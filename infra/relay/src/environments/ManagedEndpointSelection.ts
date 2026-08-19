import type {
  RelayEnvironmentLinkChallengeRequest,
  RelayManagedEndpointProvider,
} from "@t3tools/contracts/relay";

export function selectManagedEndpointProvider(input: {
  readonly request: RelayEnvironmentLinkChallengeRequest;
  readonly preferredProvider: RelayManagedEndpointProvider | undefined;
}): RelayManagedEndpointProvider | null {
  if (!input.request.managedTunnelsEnabled) {
    return null;
  }

  const supported = input.request.supportedManagedEndpointProviders;
  if (
    input.preferredProvider === "t3_relay" &&
    supported?.some((provider) => provider === "t3_relay")
  ) {
    return "t3_relay";
  }
  return "cloudflare_tunnel";
}
