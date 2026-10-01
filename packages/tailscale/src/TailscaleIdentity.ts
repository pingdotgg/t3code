import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { isTailscaleIpv4Address } from "./tailscale.ts";

/** The Node OS and DNS boundary used by passive Tailscale discovery */
export interface TailscaleIdentityNodeService {
  readonly networkInterfaces: Effect.Effect<TailscaleNetworkInterfaces>;
  readonly reverseLookup: (address: string) => Effect.Effect<string | null>;
}

/** The network interface shape needed by passive Tailscale discovery */
export interface TailscaleNetworkInterfaceInfo {
  readonly address: string;
  readonly family: string | number;
}

/** The network interfaces read by passive Tailscale discovery */
export type TailscaleNetworkInterfaces = Readonly<
  Record<string, readonly TailscaleNetworkInterfaceInfo[] | undefined>
>;

/** The Node APIs used by the Tailscale identity service */
export class TailscaleIdentityNode extends Context.Service<
  TailscaleIdentityNode,
  TailscaleIdentityNodeService
>()("@t3tools/tailscale/TailscaleIdentity/TailscaleIdentityNode") {}

/**
 * A passive, process-free source of the local MagicDNS name. Use it for reads
 * that happen without a user action, because running the Tailscale CLI on
 * macOS triggers repeated "access data from other apps" prompts
 */
export class TailscaleIdentityDiscovery extends Context.Service<
  TailscaleIdentityDiscovery,
  {
    /** Resolves this machine's MagicDNS name, or null when none is discoverable */
    readonly magicDnsName: Effect.Effect<string | null>;
  }
>()("@t3tools/tailscale/TailscaleIdentity/TailscaleIdentityDiscovery") {}

/** The cache lifetime for found and missing MagicDNS names */
export const TAILSCALE_IDENTITY_CACHE_TTL = Duration.seconds(60);

/** The time allowed for one reverse lookup */
export const TAILSCALE_IDENTITY_LOOKUP_TIMEOUT = Duration.millis(1_500);

// every Tailscale node, including Headscale ones on the default config, gets an
// address in this ULA range on its tunnel interface. 100.64.0.0/10 alone is
// shared carrier space, so the ULA address is what proves the interface is
// Tailscale's and lets us trust any PTR name, not only `*.ts.net`
const TAILSCALE_ULA_PREFIX = "fd7a:115c:a1e0:";

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;
const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

const isTailscaleInterface = (addresses: readonly TailscaleNetworkInterfaceInfo[]): boolean =>
  addresses.some(
    ({ address, family }) =>
      isIpv6Family(family) && address.toLowerCase().startsWith(TAILSCALE_ULA_PREFIX),
  );

/** Picks the lowest Tailscale IPv4 address on an interface that Tailscale owns */
const findTailscaleIpv4Address = (networkInterfaces: TailscaleNetworkInterfaces): string | null => {
  const candidates = Object.values(networkInterfaces).flatMap((addresses = []) =>
    isTailscaleInterface(addresses)
      ? addresses
          .filter(({ address, family }) => isIpv4Family(family) && isTailscaleIpv4Address(address))
          .map(({ address }) => address)
      : [],
  );

  return candidates.sort()[0] ?? null;
};

// `lookupService` echoes the address back when no PTR record exists, and a
// single-label name would not resolve from other devices
const normalizeDnsName = (hostname: string): string | null => {
  const name = hostname.trim().replace(/\.+$/u, "").toLowerCase();
  return name.includes(".") && NodeNet.isIP(name) === 0 ? name : null;
};

/** Builds the process-free Tailscale identity service */
export const make = Effect.gen(function* () {
  const node = yield* TailscaleIdentityNode;

  // keyed by address so a changed tailnet address skips the stale entry
  const namesByAddress = yield* Cache.make({
    capacity: 1,
    timeToLive: TAILSCALE_IDENTITY_CACHE_TTL,
    lookup: (address: string) =>
      node.reverseLookup(address).pipe(
        Effect.map((hostname) => (hostname === null ? null : normalizeDnsName(hostname))),
        Effect.timeout(TAILSCALE_IDENTITY_LOOKUP_TIMEOUT),
        Effect.orElseSucceed(() => null),
      ),
  });

  const magicDnsName = Effect.gen(function* () {
    const address = findTailscaleIpv4Address(yield* node.networkInterfaces);
    if (address === null) return null;

    return yield* Cache.get(namesByAddress, address);
  });

  return TailscaleIdentityDiscovery.of({ magicDnsName });
});

/** Node-backed OS and DNS APIs for standalone Node and desktop runtimes */
const nodeLayer = Layer.succeed(TailscaleIdentityNode, {
  networkInterfaces: Effect.try(() => NodeOS.networkInterfaces()).pipe(
    Effect.orElseSucceed(() => ({})),
  ),
  // the OS resolver honors macOS scoped DNS routes, so MagicDNS answers here
  // without starting the Tailscale app
  reverseLookup: (address) =>
    Effect.tryPromise(() => NodeDnsPromises.lookupService(address, 0)).pipe(
      Effect.map(({ hostname }) => hostname),
      Effect.orElseSucceed(() => null),
    ),
});

/** Live passive Tailscale identity discovery */
export const layer = Layer.effect(TailscaleIdentityDiscovery, make).pipe(Layer.provide(nodeLayer));
