import type { ServerDirectEndpoint } from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  buildTailscaleDirectBaseUrl,
  type TailscaleStatus,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
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

// Stay below the config discovery timeout so slow Tailscale drops only the tailnet name.
const TAILSCALE_ENDPOINT_TIMEOUT = Duration.seconds(3);

export class DirectEndpoints extends Context.Service<
  DirectEndpoints,
  {
    readonly resolveAvailable: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
    readonly resolve: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
  }
>()("t3/environment/DirectEndpoints") {}

// Credentials travel over HTTP; public IPs leak them and hostnames can resolve differently per client.
const isAdvertisableAddress = (address: string): boolean =>
  NodeNet.isIPv4(address) && !address.startsWith("127.") && isPrivateNetworkAddress(address);

// macOS utun names need Tailscale's IPv6 range to identify them; WARP shares its IPv4 range.
const isTailscaleInterface = (
  name: string,
  entries: ReadonlyArray<NodeOS.NetworkInterfaceInfo>,
): boolean =>
  /^tailscale/i.test(name) ||
  entries.some((entry) => entry.family === "IPv6" && isTailnetHost(entry.address));

// Windows adapter names are mutable; Linux bridges can inherit these MACs.
const WINDOWS_HOST_ADAPTER_MAC = /^(0a:00:27|00:50:56:c0:00):/i;

export function resolveBoundEndpoints(input: {
  readonly platform: NodeJS.Platform;
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
            !entry.internal &&
            entry.family === "IPv4" &&
            isAdvertisableAddress(entry.address) &&
            !(input.platform === "win32" && WINDOWS_HOST_ADAPTER_MAC.test(entry.mac)),
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

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  // Only the service default listens on every interface without being asked,
  // so only it checks once whether it runs in a cloud. The check starts now so
  // the first client does not wait for its timeout.
  const onCloudVm = config.privateNetworkOnly
    ? yield* Effect.cached(probeCloudMetadata)
    : Effect.succeed(false);
  yield* Effect.forkDetach(onCloudVm);

  const cachedStatus = yield* Ref.make<TailscaleStatus | null>(null);
  const servedEndpoint = yield* Ref.make<Option.Option<string>>(Option.none());
  const resolveAvailable = Effect.fn("DirectEndpoints.resolveAvailable")(function* () {
    const interfaces = NodeOS.networkInterfaces();
    const endpoints = [
      ...resolveBoundEndpoints({
        platform,
        host: config.host,
        port: config.port,
        interfaces,
        onCloudVm: yield* onCloudVm,
      }),
    ];
    const servedUrl = yield* Ref.get(servedEndpoint);
    if (Option.isSome(servedUrl)) endpoints.push({ kind: "tailnet", httpBaseUrl: servedUrl.value });
    const directUrl = buildTailscaleDirectBaseUrl({
      status: yield* Ref.get(cachedStatus),
      port: config.port,
      host: config.host,
      localAddresses: Object.values(interfaces).flatMap((entries) =>
        (entries ?? []).filter((entry) => !entry.internal).map((entry) => entry.address),
      ),
    });
    if (directUrl !== null) endpoints.push({ kind: "tailnet", httpBaseUrl: directUrl });
    return endpoints;
  });

  const resolve = Effect.gen(function* () {
    if (isLoopbackHost(config.host) && !config.tailscaleServeEnabled)
      return yield* resolveAvailable();
    const observedStatus = yield* Ref.make<TailscaleStatus | null>(null);
    const discovered = yield* readTailscaleStatus.pipe(
      Effect.tap((status) => Ref.set(observedStatus, status)),
      Effect.flatMap((status) =>
        Effect.gen(function* () {
          let servedUrl: string | null = null;
          if (config.tailscaleServeEnabled && status.magicDnsName !== null) {
            const url = buildTailscaleHttpsBaseUrl({
              magicDnsName: status.magicDnsName,
              servePort: config.tailscaleServePort,
            });
            if (yield* probeTailscaleHttpsEndpoint({ baseUrl: url })) servedUrl = url;
          }
          return servedUrl;
        }),
      ),
      Effect.timeoutOption(TAILSCALE_ENDPOINT_TIMEOUT),
      Effect.orElseSucceed(() => Option.none()),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    yield* Ref.set(cachedStatus, yield* Ref.get(observedStatus));
    yield* Ref.set(servedEndpoint, Option.flatMap(discovered, Option.fromNullishOr));
    return yield* resolveAvailable();
  });

  return DirectEndpoints.of({
    resolveAvailable,
    resolve: Effect.fn("DirectEndpoints.resolve")(function () {
      return resolve;
    }),
  });
});

export const layer = Layer.effect(DirectEndpoints, make);
