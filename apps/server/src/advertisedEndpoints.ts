import type { AdvertisedEndpoint } from "@t3tools/contracts";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";

/**
 * Builds the endpoints the server advertises in its environment descriptor.
 * The endpoint ids, provider descriptors, and default flag are a contract with
 * the desktop and mobile clients — change them in lockstep.
 */
export const buildServerAdvertisedEndpoints = (input: {
  readonly managedEndpoint: RelayManagedEndpoint | null;
  readonly tailnetHttpsBaseUrl: string | null;
  readonly directHttpBaseUrl: string;
  readonly directReachability: "loopback" | "lan";
}): ReadonlyArray<AdvertisedEndpoint> => {
  const managedEndpoints = input.managedEndpoint
    ? [
        createAdvertisedEndpoint({
          id: "managed-tunnel",
          label: "SurgeCode Cloud",
          provider: {
            id: input.managedEndpoint.providerKind,
            label: "SurgeCode Cloud",
            kind: "tunnel",
            isAddon: false,
          },
          httpBaseUrl: input.managedEndpoint.httpBaseUrl,
          reachability: "public",
          source: "server",
          status: "available",
          isDefault: true,
          description: "Stable encrypted tunnel managed by SurgeCode Cloud.",
        }),
      ]
    : [];
  const tailscaleEndpoints = input.tailnetHttpsBaseUrl
    ? [
        createAdvertisedEndpoint({
          id: "tailscale-serve",
          label: "Tailscale",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: false,
          },
          httpBaseUrl: input.tailnetHttpsBaseUrl,
          reachability: "private-network",
          source: "server",
          status: "available",
          isDefault: input.managedEndpoint === null,
        }),
      ]
    : [];

  return [
    ...managedEndpoints,
    ...tailscaleEndpoints,
    createAdvertisedEndpoint({
      id: "direct",
      label: "Direct",
      provider: { id: "direct", label: "Direct", kind: "core", isAddon: false },
      httpBaseUrl: input.directHttpBaseUrl,
      reachability: input.directReachability,
      source: "server",
      status: "available",
    }),
  ];
};
