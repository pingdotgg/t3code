import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  ExecutionEnvironmentDescriptor,
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
} from "@t3tools/contracts";
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
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

const VPN_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "vpn",
  label: "VPN",
  kind: "private-network",
  isAddon: true,
};

// CGNAT is shared with other VPNs; adapter identity works without current CLI status. A stopped
// Tailscale on Linux keeps tailscale0 with only a link-local address, so the name alone is not enough.
function isTailscaleInterface(
  interfaceName: string,
  interfaceAddresses: NonNullable<NetworkInterfaces[string]>,
): boolean {
  return interfaceAddresses.some(
    (address) =>
      !address.internal &&
      (address.family === "IPv6"
        ? /^fd7a:115c:a1e0:/iu.test(address.address)
        : /^tailscale(?:\d+|ipv[46])?$/iu.test(interfaceName) &&
          isTailscaleIpv4Address(address.address)),
  );
}

function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NetworkInterfaces;
  readonly status: TailscaleStatus | null;
}): readonly AdvertisedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: AdvertisedEndpoint[] = [];
  const interfaces = Object.entries(input.networkInterfaces);

  // A stopped Tailscale still reports the netmap it had, so its addresses prove nothing.
  const tailnetIpv4Addresses =
    input.status?.running === false ? [] : (input.status?.tailnetIpv4Addresses ?? []);
  // An unclaimed CGNAT address is offered as a VPN route only when the host shows no Tailscale
  // identity; the address alone does not show which network it came from.
  const hostRunsTailscale =
    tailnetIpv4Addresses.length > 0 ||
    interfaces.some(
      ([name, addresses]) => addresses !== undefined && isTailscaleInterface(name, addresses),
    );

  for (const [interfaceName, interfaceAddresses] of interfaces) {
    if (!interfaceAddresses) continue;
    const onTailscaleInterface = isTailscaleInterface(interfaceName, interfaceAddresses);

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (seen.has(address.address)) continue;
      const isTailscaleAddress =
        onTailscaleInterface || tailnetIpv4Addresses.includes(address.address);
      if (!isTailscaleAddress && hostRunsTailscale) continue;
      seen.add(address.address);

      const httpBaseUrl = `http://${address.address}:${input.port}`;
      endpoints.push(
        createAdvertisedEndpoint({
          source: "desktop-addon",
          httpBaseUrl,
          reachability: "private-network",
          status: "available",
          ...(isTailscaleAddress
            ? {
                provider: TAILSCALE_ENDPOINT_PROVIDER,
                id: `tailscale-ip:${httpBaseUrl}`,
                label: "Tailscale IP",
                description: "Reachable from devices on the same Tailnet.",
              }
            : {
                provider: VPN_ENDPOINT_PROVIDER,
                id: `vpn-ip:${httpBaseUrl}`,
                label: "VPN IP",
                description: "Reachable from devices on the same VPN.",
              }),
        }),
      );
    }
  }

  return endpoints;
}

// The backend may run elsewhere (WSL), so ask it for its id instead of reading the state dir.
const probeServesThisBackend = (localHttpUrl: string) => (baseUrl: string) =>
  HttpClient.get(new URL("/.well-known/t3/environment", localHttpUrl)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    Effect.flatMap(({ environmentId }) => probeTailscaleHttpsEndpoint({ baseUrl, environmentId })),
    Effect.orElseSucceed(() => false),
  );

const resolveTailscaleMagicDnsAdvertisedEndpoint = Effect.fn(
  "resolveTailscaleMagicDnsAdvertisedEndpoint",
)(function* (input: {
  readonly dnsName: string | null;
  readonly localHttpUrl: string;
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
  const probe = (input.probe ?? probeServesThisBackend(input.localHttpUrl))(httpBaseUrl);
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
      localHttpUrl: `http://127.0.0.1:${input.port}`,
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
