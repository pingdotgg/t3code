import type { ServerDirectEndpoint } from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { isTailnetHost } from "@t3tools/shared/hostClassification";

import * as ServerConfig from "../config.ts";
import {
  formatHostForUrl,
  isLoopbackHost,
  isPrivateNetworkAddress,
  isWildcardHost,
  VIRTUAL_INTERFACE,
} from "../startupAccess.ts";

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

/**
 * Stays under the config read's own discovery timeout, so a slow `tailscale`
 * CLI drops only the tailnet name and never the LAN addresses.
 */
const TAILSCALE_ENDPOINT_TIMEOUT = Duration.seconds(3);

export class DirectEndpoints extends Context.Service<
  DirectEndpoints,
  {
    readonly resolve: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
  }
>()("t3/environment/DirectEndpoints") {}

/**
 * These routes are plain HTTP and carry the client's credential, so a public
 * address would send it across the internet unencrypted, and a name
 * (`server.local`) can resolve to a different machine on each client's network.
 */
const isAdvertisableAddress = (address: string): boolean =>
  NodeNet.isIPv4(address) && !address.startsWith("127.") && isPrivateNetworkAddress(address);

/**
 * Tailscale's own interface: `tailscale0` on Linux, "Tailscale" on Windows.
 * macOS names every tunnel `utunN`, so there it is the one that also carries
 * an address in Tailscale's IPv6 range. Cloudflare WARP and other VPNs assign
 * from the same IPv4 range, so the IPv4 address alone proves nothing.
 */
const isTailscaleInterface = (
  name: string,
  entries: ReadonlyArray<NodeOS.NetworkInterfaceInfo>,
): boolean =>
  /^tailscale/i.test(name) ||
  entries.some((entry) => entry.family === "IPv6" && isTailnetHost(entry.address));

export function resolveBoundEndpoints(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: NetworkInterfacesMap;
  /** A cloud VM's private network is its provider's, which no client shares. */
  readonly onCloudVm?: boolean;
}): ReadonlyArray<ServerDirectEndpoint> {
  if (isLoopbackHost(input.host)) return [];
  const tailscaleAddresses = new Set(
    Object.entries(input.interfaces).flatMap(([name, entries = []]) =>
      isTailscaleInterface(name, entries) ? entries.map((entry) => entry.address) : [],
    ),
  );
  const addresses = isWildcardHost(input.host)
    ? Object.entries(input.interfaces)
        .flatMap(([name, entries]) => (VIRTUAL_INTERFACE.test(name) ? [] : (entries ?? [])))
        .filter(
          (entry) =>
            !entry.internal && entry.family === "IPv4" && isAdvertisableAddress(entry.address),
        )
        .map((entry) => entry.address)
    : [input.host!].filter(isAdvertisableAddress);
  return [...new Set(addresses)]
    .filter((address) => !input.onCloudVm || tailscaleAddresses.has(address))
    .map((address) => ({
      kind: tailscaleAddresses.has(address) ? "tailnet" : "lan",
      httpBaseUrl: `http://${formatHostForUrl(address)}:${input.port}/`,
    }));
}

/**
 * AWS, GCP, Azure, DigitalOcean, Hetzner, Linode, Vultr, and Oracle all serve
 * instance metadata at this address. A plain TCP connect skips HTTP proxies,
 * which would otherwise answer for a machine that is not in a cloud.
 */
const CLOUD_METADATA_ADDRESS = "169.254.169.254";
const CLOUD_METADATA_TIMEOUT_MS = 300;

const probeCloudMetadata = Effect.callback<boolean>((resume) => {
  const socket = NodeNet.connect({
    host: CLOUD_METADATA_ADDRESS,
    port: 80,
    timeout: CLOUD_METADATA_TIMEOUT_MS,
  });
  let settled = false;
  const settle = (found: boolean) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resume(Effect.succeed(found));
  };
  socket.once("connect", () => settle(true));
  socket.once("timeout", () => settle(false));
  socket.once("error", () => settle(false));
  return Effect.sync(() => socket.destroy());
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  // Only the service default listens on every interface without being asked,
  // so only it checks once whether it runs in a cloud. The check starts now so
  // the first client does not wait for its timeout.
  const onCloudVm = config.privateNetworkOnly
    ? yield* Effect.cached(probeCloudMetadata)
    : Effect.succeed(false);
  yield* Effect.forkDetach(onCloudVm);

  const resolve = Effect.gen(function* () {
    const endpoints = [
      ...resolveBoundEndpoints({
        host: config.host,
        port: config.port,
        interfaces: NodeOS.networkInterfaces(),
        onCloudVm: yield* onCloudVm,
      }),
    ];
    // Tailscale Serve terminates HTTPS on the tailnet name and forwards to
    // loopback, so it works even for a loopback-only server. The name is only
    // listed once it answers as this server: Serve setup can fail without
    // stopping startup. Anything slower than the probe leaves it out rather
    // than holding back the addresses already found.
    if (config.tailscaleServeEnabled) {
      const servedUrl = yield* readTailscaleStatus.pipe(
        Effect.map((status) => status.magicDnsName),
        Effect.flatMap((magicDnsName) => {
          if (magicDnsName === null) return Effect.succeed(null);
          const httpBaseUrl = buildTailscaleHttpsBaseUrl({
            magicDnsName,
            servePort: config.tailscaleServePort,
          });
          return probeTailscaleHttpsEndpoint({ baseUrl: httpBaseUrl }).pipe(
            Effect.map((reachable) => (reachable ? httpBaseUrl : null)),
          );
        }),
        Effect.timeoutOption(TAILSCALE_ENDPOINT_TIMEOUT),
        Effect.map(Option.flatMap(Option.fromNullishOr)),
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (Option.isSome(servedUrl)) {
        endpoints.push({ kind: "tailnet", httpBaseUrl: servedUrl.value });
      }
    }
    return endpoints;
  });

  return DirectEndpoints.of({ resolve: () => resolve });
});

export const layer = Layer.effect(DirectEndpoints, make);
