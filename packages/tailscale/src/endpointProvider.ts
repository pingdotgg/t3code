import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import type {
  AdvertisedEndpoint,
  AdvertisedEndpointProvider,
  AdvertisedEndpointSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  buildTailscaleHttpsBaseUrl,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
} from "./tailscale.ts";

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

/** Minimal shape of a `node:os` networkInterfaces() entry, kept structural so
 * desktop and server can pass their own readings without a shared service. */
export interface TailscaleNetworkInterfaceInfo {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}

export type TailscaleNetworkInterfaces = Readonly<
  Record<string, readonly TailscaleNetworkInterfaceInfo[] | undefined>
>;

function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly source: AdvertisedEndpointSource;
  readonly networkInterfaces: TailscaleNetworkInterfaces;
}): readonly AdvertisedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: AdvertisedEndpoint[] = [];

  for (const interfaceAddresses of Object.values(input.networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4" && address.family !== 4) continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);

      endpoints.push(
        createAdvertisedEndpoint({
          provider: TAILSCALE_ENDPOINT_PROVIDER,
          source: input.source,
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
  readonly source: AdvertisedEndpointSource;
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
      source: input.source,
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

/** Synthesizes Tailscale advertised endpoints (per-interface Tailnet IPs plus
 * the MagicDNS HTTPS endpoint) with stable `tailscale-ip:`/`tailscale-magicdns:`
 * ids shared by the desktop and server producers. */
export const resolveTailscaleAdvertisedEndpoints = Effect.fn("resolveTailscaleAdvertisedEndpoints")(
  function* (input: {
    readonly port: number;
    readonly source: AdvertisedEndpointSource;
    readonly serveEnabled?: boolean;
    readonly servePort?: number;
    readonly networkInterfaces: TailscaleNetworkInterfaces;
    readonly statusJson?: string | null;
    readonly readMagicDnsName?: Effect.Effect<
      string | null,
      never,
      ChildProcessSpawner.ChildProcessSpawner
    >;
    readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
  }): Effect.fn.Return<
    readonly AdvertisedEndpoint[],
    never,
    ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
  > {
    const ipEndpoints = resolveTailscaleIpAdvertisedEndpoints(input);
    const readDnsName =
      input.readMagicDnsName ??
      readTailscaleStatus.pipe(
        Effect.map((status) => status.magicDnsName),
        Effect.orElseSucceed(() => null),
      );
    const dnsName =
      input.statusJson === undefined
        ? yield* readDnsName
        : input.statusJson
          ? yield* parseTailscaleMagicDnsName(input.statusJson).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;
    const magicDnsEndpoint = yield* resolveTailscaleMagicDnsAdvertisedEndpoint({
      dnsName,
      source: input.source,
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
