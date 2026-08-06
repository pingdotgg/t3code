import * as NodeOS from "node:os";

import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  isTailscaleIpv4Address,
  resolveTailscaleAdvertisedEndpoints,
  type TailscaleNetworkInterfaces,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import {
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  resolveListeningPort,
} from "../startupAccess.ts";

const SERVER_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "server-core",
  label: "Server",
  kind: "core",
  isAddon: false,
};

/** How long a resolved endpoint set is reused before `tailscale status` runs
 * again. Repeated client polls must not re-spawn the Tailscale CLI. */
const ENDPOINT_CACHE_TTL = "60 seconds";

const isPrivateIpv4 = (address: string): boolean => {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets as [number, number, number, number];
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return first === 192 && second === 168;
};

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

/** Binding mode implied by the configured host, which decides which addresses
 * actually accept connections. */
type BindingMode = "loopback" | "wildcard" | "specific";

const resolveBindingMode = (host: string | undefined): BindingMode => {
  if (isWildcardHost(host)) return "wildcard";
  // An unset host means the server binds 127.0.0.1 (see server.ts).
  if (isLoopbackHost(host)) return "loopback";
  return "specific";
};

/** Tailscale Serve proxies to 127.0.0.1, so its HTTPS endpoint stays reachable
 * under a loopback binding; the plain Tailnet-IP HTTP endpoints do not. */
const isHttpsEndpoint = (endpoint: AdvertisedEndpoint): boolean =>
  endpoint.httpBaseUrl.startsWith("https://");

export interface ResolveServerAdvertisedEndpointsInput {
  readonly port: number;
  readonly host: string | undefined;
  readonly networkInterfaces: TailscaleNetworkInterfaces;
  readonly tailscaleEndpoints: readonly AdvertisedEndpoint[];
}

/** Pure projection of the server's own reachable endpoints, given its binding,
 * the host's network interfaces, and any Tailscale endpoints resolved
 * separately. Exported for tests. */
export function resolveServerAdvertisedEndpoints(
  input: ResolveServerAdvertisedEndpointsInput,
): readonly AdvertisedEndpoint[] {
  const mode = resolveBindingMode(input.host);
  const loopbackEndpoint = createAdvertisedEndpoint({
    provider: SERVER_ENDPOINT_PROVIDER,
    source: "server",
    id: `server-loopback:${input.port}`,
    label: "This machine",
    httpBaseUrl: `http://127.0.0.1:${input.port}`,
    reachability: "loopback",
    status: "available",
    description: "Loopback endpoint for this server.",
  });

  if (mode === "loopback") {
    return [loopbackEndpoint, ...input.tailscaleEndpoints.filter(isHttpsEndpoint)];
  }

  if (mode === "specific") {
    // A specific non-loopback binding is not listening on 127.0.0.1, so neither
    // the loopback endpoint nor Tailscale Serve (which proxies there) applies.
    // A bound Tailnet IP is covered by the record below.
    const rawHost = input.host ?? "";
    const host = formatHostForUrl(rawHost);
    const { reachability, label } = isTailscaleIpv4Address(rawHost)
      ? ({ reachability: "private-network", label: "Private network" } as const)
      : isPrivateIpv4(rawHost)
        ? ({ reachability: "lan", label: "Local network" } as const)
        : ({ reachability: "public", label: "Public IP" } as const);
    const httpBaseUrl = `http://${host}:${input.port}`;
    return [
      createAdvertisedEndpoint({
        provider: SERVER_ENDPOINT_PROVIDER,
        source: "server",
        id: `server-${reachability}:${httpBaseUrl}`,
        label,
        httpBaseUrl,
        reachability,
        status: "available",
      }),
    ];
  }

  const endpoints: AdvertisedEndpoint[] = [loopbackEndpoint];
  const seen = new Set<string>();
  let hasDefaultLan = false;

  for (const interfaceAddresses of Object.values(input.networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const entry of interfaceAddresses) {
      if (entry.internal) continue;
      if (!isIpv4Family(entry.family)) continue;
      const address = entry.address;
      if (address.startsWith("127.") || address.startsWith("169.254.")) continue;
      // Tailnet addresses are advertised by the Tailscale provider instead.
      if (isTailscaleIpv4Address(address)) continue;
      if (seen.has(address)) continue;
      seen.add(address);

      const isLan = isPrivateIpv4(address);
      const httpBaseUrl = `http://${address}:${input.port}`;
      const isDefault = isLan && !hasDefaultLan;
      if (isDefault) hasDefaultLan = true;

      endpoints.push(
        createAdvertisedEndpoint({
          provider: SERVER_ENDPOINT_PROVIDER,
          source: "server",
          id: `server-${isLan ? "lan" : "public"}:${httpBaseUrl}`,
          label: isLan ? "Local network" : "Public IP",
          httpBaseUrl,
          reachability: isLan ? "lan" : "public",
          status: "available",
          ...(isDefault ? { isDefault: true } : {}),
        }),
      );
    }
  }

  return [...endpoints, ...input.tailscaleEndpoints];
}

export class ServerAdvertisedEndpoints extends Context.Service<
  ServerAdvertisedEndpoints,
  {
    readonly getEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("t3/remoteAccess/ServerAdvertisedEndpoints") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;

  const readNetworkInterfaces = Effect.sync(() => NodeOS.networkInterfaces()).pipe(
    Effect.map((interfaces): TailscaleNetworkInterfaces => interfaces),
  );

  const resolveEndpoints = Effect.gen(function* () {
    const port = resolveListeningPort(httpServer.address, config.port);
    const networkInterfaces = yield* readNetworkInterfaces;
    const mode = resolveBindingMode(config.host);

    // Skip the Tailscale resolver when nothing Tailscale-reachable could exist:
    // spawning the CLI triggers a macOS TCC prompt on sandboxed installs.
    const shouldResolveTailscale =
      mode === "wildcard" || (mode === "loopback" && config.tailscaleServeEnabled);
    const tailscaleEndpoints = shouldResolveTailscale
      ? yield* resolveTailscaleAdvertisedEndpoints({
          port,
          source: "server",
          serveEnabled: config.tailscaleServeEnabled,
          servePort: config.tailscaleServePort,
          networkInterfaces,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        )
      : [];

    return resolveServerAdvertisedEndpoints({
      port,
      host: config.host,
      networkInterfaces,
      tailscaleEndpoints,
    });
  });

  const getEndpoints = yield* Effect.cachedWithTTL(resolveEndpoints, ENDPOINT_CACHE_TTL);

  return ServerAdvertisedEndpoints.of({
    getEndpoints: getEndpoints.pipe(
      Effect.withSpan("server.remoteAccess.resolveAdvertisedEndpoints"),
    ),
  });
});

export const layer = Layer.effect(ServerAdvertisedEndpoints, make);
