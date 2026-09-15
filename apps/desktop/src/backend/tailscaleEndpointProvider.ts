import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  isTailscaleIpv4Address,
  probeTailscaleHttpsEndpoint,
  type TailscaleIdentity,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NetworkInterfaces;
}): readonly AdvertisedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: AdvertisedEndpoint[] = [];

  for (const interfaceAddresses of Object.values(input.networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);

      endpoints.push(
        createAdvertisedEndpoint({
          provider: TAILSCALE_ENDPOINT_PROVIDER,
          source: "desktop-addon",
          id: `tailscale-ip:http://${address.address}:${input.port}`,
          label: "Tailscale IP",
          httpBaseUrl: `http://${address.address}:${input.port}`,
          reachability: "private-network",
          status: "available",
          description: "Reachable from devices on the same Tailnet.",
        }),
      );
    }
  }

  return endpoints;
}

const resolveTailscaleMagicDnsAdvertisedEndpoint = Effect.fn(
  "resolveTailscaleMagicDnsAdvertisedEndpoint",
)(function* (input: {
  readonly dnsName: string;
  readonly serveEnabled: boolean;
  readonly servePort?: number;
  readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
}): Effect.fn.Return<AdvertisedEndpoint, never, HttpClient.HttpClient> {
  const httpBaseUrl = buildTailscaleHttpsBaseUrl({
    magicDnsName: input.dnsName,
    ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
  });
  const probe =
    input.probe?.(httpBaseUrl) ??
    probeTailscaleHttpsEndpoint({
      baseUrl: httpBaseUrl,
    });
  const isReachable = input.serveEnabled ? yield* probe : false;

  return createAdvertisedEndpoint({
    provider: TAILSCALE_ENDPOINT_PROVIDER,
    source: "desktop-addon",
    id: `tailscale-magicdns:${httpBaseUrl}`,
    label: "Tailscale HTTPS",
    httpBaseUrl,
    reachability: "private-network",
    hostedHttpsCompatibility: isReachable ? "compatible" : "requires-configuration",
    status: isReachable ? "available" : "unavailable",
    description: isReachable
      ? "HTTPS endpoint served by Tailscale Serve."
      : "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
  });
});

/** Resolves the desktop endpoints for every local Tailscale address and DNS name */
export const resolveTailscaleAdvertisedEndpoints = Effect.fn("resolveTailscaleAdvertisedEndpoints")(
  function* (input: {
    readonly port: number;
    readonly serveEnabled?: boolean;
    readonly servePort?: number;
    readonly networkInterfaces: NetworkInterfaces;
    readonly identity: TailscaleIdentity;
    readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
  }): Effect.fn.Return<readonly AdvertisedEndpoint[], never, HttpClient.HttpClient> {
    const ipEndpoints = resolveTailscaleIpAdvertisedEndpoints(input);
    const magicDnsEndpoints = yield* Effect.forEach(input.identity.dnsNames, (dnsName) =>
      resolveTailscaleMagicDnsAdvertisedEndpoint({
        dnsName,
        serveEnabled: input.serveEnabled === true,
        ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
        ...(input.probe === undefined ? {} : { probe: input.probe }),
      }),
    );

    return [...ipEndpoints, ...magicDnsEndpoints];
  },
);
