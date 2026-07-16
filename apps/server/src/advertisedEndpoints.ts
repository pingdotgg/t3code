import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";

/**
 * Builds the endpoints the server advertises in its environment descriptor.
 * The endpoint ids, provider descriptors, and default flag are a contract with
 * the desktop and mobile clients — change them in lockstep.
 */
export const buildServerAdvertisedEndpoints = (input: {
  readonly tailnetHttpsBaseUrl: string | null;
  readonly directHttpBaseUrl: string;
  readonly directReachability: "loopback" | "lan";
}): ReadonlyArray<AdvertisedEndpoint> => {
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
          isDefault: true,
        }),
      ]
    : [];

  return [
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
