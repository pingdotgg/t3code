import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  isTailscaleIpv4Address,
  parseTailscaleStatus,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
  type TailscaleStatus,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

export { parseTailscaleMagicDnsName } from "@t3tools/tailscale";

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NetworkInterfaces;
  readonly status: TailscaleStatus | null;
}): readonly AdvertisedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: AdvertisedEndpoint[] = [];

  for (const [interfaceName, interfaceAddresses] of Object.entries(input.networkInterfaces)) {
    if (!interfaceAddresses) continue;

    // CGNAT space is shared with other VPNs. Native adapter identity also
    // works when the CLI is missing or its cached status predates a connection.
    const isTailscaleInterface =
      /^tailscale(?:\d+|ipv[46])?$/iu.test(interfaceName) ||
      interfaceAddresses.some(
        (address) =>
          !address.internal &&
          address.family === "IPv6" &&
          /^fd7a:115c:a1e0:/iu.test(address.address),
      );

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (!isTailscaleInterface && !input.status?.tailnetIpv4Addresses.includes(address.address)) {
        continue;
      }
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
  readonly dnsName: string | null;
  readonly serveEnabled: boolean;
  readonly servePort?: number;
  readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
}): Effect.fn.Return<Option.Option<AdvertisedEndpoint>, never, HttpClient.HttpClient> {
  if (!input.dnsName) {
    return Option.none();
  }

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

  return Option.some(
    createAdvertisedEndpoint({
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
    }),
  );
});

export const resolveTailscaleAdvertisedEndpoints = Effect.fn("resolveTailscaleAdvertisedEndpoints")(
  function* (input: {
    readonly port: number;
    readonly serveEnabled?: boolean;
    readonly servePort?: number;
    readonly networkInterfaces: NetworkInterfaces;
    readonly statusJson?: string | null;
    readonly readStatus?: Effect.Effect<
      TailscaleStatus | null,
      never,
      ChildProcessSpawner.ChildProcessSpawner
    >;
    readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
  }): Effect.fn.Return<
    readonly AdvertisedEndpoint[],
    never,
    ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
  > {
    const readStatus =
      input.readStatus ?? readTailscaleStatus.pipe(Effect.orElseSucceed(() => null));
    const status =
      input.statusJson === undefined
        ? yield* readStatus
        : input.statusJson
          ? yield* parseTailscaleStatus(input.statusJson).pipe(Effect.orElseSucceed(() => null))
          : null;
    const ipEndpoints = resolveTailscaleIpAdvertisedEndpoints({ ...input, status });
    const magicDnsEndpoint = yield* resolveTailscaleMagicDnsAdvertisedEndpoint({
      dnsName: status?.magicDnsName ?? null,
      serveEnabled: input.serveEnabled === true,
      ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
      ...(input.probe === undefined ? {} : { probe: input.probe }),
    });

    return Option.match(magicDnsEndpoint, {
      onNone: () => ipEndpoints,
      onSome: (endpoint) => [...ipEndpoints, endpoint],
    });
  },
);
