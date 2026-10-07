/**
 * DirectEndpoints - the LAN and tailnet addresses this server listens on now.
 *
 * Clients connected one way (often T3 Connect) save these as extra routes so
 * they can move to a faster path when one is reachable, and replace a saved
 * LAN address when DHCP or a new Wi-Fi network changes it. Only addresses the
 * server is actually bound to are listed: a loopback-only server lists none,
 * because its loopback address means a different machine to every client.
 */
import type { ServerDirectEndpoint } from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  isTailscaleIpv4Address,
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

import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import * as ServerConfig from "../config.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

/**
 * Stays under the config read's own discovery timeout, so a slow `tailscale`
 * CLI drops only the tailnet name and never the LAN addresses. An empty list
 * would make clients forget the routes they learned.
 */
const TAILSCALE_ENDPOINT_TIMEOUT = Duration.seconds(3);

export class DirectEndpoints extends Context.Service<
  DirectEndpoints,
  {
    readonly resolve: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
  }
>()("t3/environment/DirectEndpoints") {}

/**
 * Only numeric private-network and tailnet IPv4 addresses are reported. These
 * routes are plain HTTP and carry the client's credential, so a public address
 * would send it across the internet unencrypted, and a name (`server.local`)
 * can resolve to a different machine on each client's network.
 */
const isAdvertisableAddress = (address: string): boolean =>
  NodeNet.isIPv4(address) &&
  !address.startsWith("127.") &&
  !address.startsWith("169.254.") &&
  (isTailscaleIpv4Address(address) || isPrivateNetworkHost(address));

/**
 * Container and VM networks (Docker, libvirt, VMware, VirtualBox, Hyper-V, and
 * macOS's `bridge100`+) have private addresses only this machine reaches. A
 * host bridge such as `br0` or Proxmox's `vmbr0` carries the LAN address, so
 * it stays listed.
 */
const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|podman|cni|flannel|cali|lxcbr|lxdbr|bridge1\d\d)/;

/**
 * Plain HTTP endpoints for the private addresses a server bound to `host`
 * accepts. IPv4 only: link-local and temporary IPv6 addresses change too
 * often to be worth saving.
 */
export function resolveBoundEndpoints(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: NetworkInterfacesMap;
}): ReadonlyArray<ServerDirectEndpoint> {
  if (isLoopbackHost(input.host)) return [];
  const addresses = isWildcardHost(input.host)
    ? Object.entries(input.interfaces)
        .flatMap(([name, entries]) => (VIRTUAL_INTERFACE.test(name) ? [] : (entries ?? [])))
        .filter(
          (entry) =>
            !entry.internal && entry.family === "IPv4" && isAdvertisableAddress(entry.address),
        )
        .map((entry) => entry.address)
    : [input.host!].filter(isAdvertisableAddress);
  return [...new Set(addresses)].map((address) => ({
    kind: isTailscaleIpv4Address(address) ? "tailnet" : "lan",
    httpBaseUrl: `http://${formatHostForUrl(address)}:${input.port}/`,
  }));
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;

  const resolve = Effect.gen(function* () {
    const endpoints = [
      ...resolveBoundEndpoints({
        host: config.host,
        port: config.port,
        interfaces: NodeOS.networkInterfaces(),
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
