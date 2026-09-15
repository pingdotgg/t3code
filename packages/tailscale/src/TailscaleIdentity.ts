import * as NodeDnsPromises from "node:dns/promises";
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { isTailscaleIpv4Address } from "./tailscale.ts";

/** The identity names discovered from the local Tailscale interfaces */
export interface TailscaleIdentity {
  readonly dnsNames: readonly string[];
}

/** The Node OS and DNS boundary used by passive Tailscale discovery */
export interface TailscaleIdentityNodeService {
  readonly networkInterfaces: Effect.Effect<TailscaleNetworkInterfaces>;
  readonly reverseLookup: (address: string) => Effect.Effect<readonly string[]>;
}

/** The network interface shape needed by passive Tailscale discovery */
export interface TailscaleNetworkInterfaceInfo {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
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

/** A passive, process-free source of the local Tailscale DNS identity */
export class TailscaleIdentityDiscovery extends Context.Service<
  TailscaleIdentityDiscovery,
  {
    readonly discover: Effect.Effect<TailscaleIdentity>;
  }
>()("@t3tools/tailscale/TailscaleIdentity/TailscaleIdentityDiscovery") {}

/** The cache lifetime for successful and empty identity results */
export const TAILSCALE_IDENTITY_CACHE_TTL = Duration.seconds(60);

/** The total time allowed for all reverse lookups in one discovery */
export const TAILSCALE_IDENTITY_LOOKUP_TIMEOUT = Duration.millis(1_500);

const TAILSCALE_LOOKUP_CONCURRENCY = 4;
const TAILSCALE_DNS_SUFFIX = ".ts.net";
const TAILSCALE_IDENTITY_CACHE_TTL_MILLIS = Duration.toMillis(TAILSCALE_IDENTITY_CACHE_TTL);

interface CachedIdentity {
  readonly addressSetKey: string;
  readonly expiresAt: number;
  readonly result: Deferred.Deferred<TailscaleIdentity>;
}

const isValidDnsLabel = (label: string): boolean =>
  label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label);

/** Normalizes a PTR result when it is a fully-qualified Tailscale name */
const normalizeTailscaleDnsName = (value: string): string | undefined => {
  const normalized = value.trim().replace(/\.+$/u, "").toLowerCase();
  if (!normalized.endsWith(TAILSCALE_DNS_SUFFIX)) {
    return undefined;
  }

  const labels = normalized.split(".");
  if (
    labels.length < 3 ||
    normalized.length > 253 ||
    labels.some((label) => !isValidDnsLabel(label))
  ) {
    return undefined;
  }

  return normalized;
};

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const readTailscaleIpv4Addresses = (
  networkInterfaces: TailscaleNetworkInterfaces,
): readonly string[] => {
  const addresses = new Set<string>();

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (
        !address.internal &&
        isIpv4Family(address.family) &&
        isTailscaleIpv4Address(address.address)
      ) {
        addresses.add(address.address);
      }
    }
  }

  return [...addresses].sort();
};

const addressSetKey = (addresses: readonly string[]): string => addresses.join("\u0000");

const discoverForAddresses = (
  node: TailscaleIdentityNodeService,
  addresses: readonly string[],
): Effect.Effect<TailscaleIdentity> =>
  Effect.forEach(addresses, (address) => node.reverseLookup(address), {
    concurrency: TAILSCALE_LOOKUP_CONCURRENCY,
  }).pipe(
    Effect.map((results) => {
      const names = new Set<string>();
      for (const result of results) {
        for (const value of result) {
          const name = normalizeTailscaleDnsName(value);
          if (name !== undefined) {
            names.add(name);
          }
        }
      }

      return { dnsNames: [...names].sort() } satisfies TailscaleIdentity;
    }),
    Effect.timeout(TAILSCALE_IDENTITY_LOOKUP_TIMEOUT),
    Effect.orElseSucceed(() => ({ dnsNames: [] })),
  );

/** Builds the process-free Tailscale identity service */
export const make = Effect.gen(function* () {
  const node = yield* TailscaleIdentityNode;
  const cacheLock = yield* Semaphore.make(1);
  let cachedIdentity: CachedIdentity | undefined;

  const discover = Effect.gen(function* () {
    const networkInterfaces = yield* node.networkInterfaces;
    const addresses = readTailscaleIpv4Addresses(networkInterfaces);
    const currentAddressSetKey = addressSetKey(addresses);

    const result = yield* cacheLock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (
          cachedIdentity !== undefined &&
          cachedIdentity.addressSetKey === currentAddressSetKey &&
          cachedIdentity.expiresAt > now
        ) {
          return cachedIdentity.result;
        }

        const result = yield* Deferred.make<TailscaleIdentity>();
        cachedIdentity = {
          addressSetKey: currentAddressSetKey,
          expiresAt: now + TAILSCALE_IDENTITY_CACHE_TTL_MILLIS,
          result,
        };
        yield* discoverForAddresses(node, addresses).pipe(
          Effect.flatMap((identity) => Deferred.succeed(result, identity)),
          Effect.forkDetach,
        );

        return result;
      }).pipe(Effect.uninterruptible),
    );

    return yield* Deferred.await(result);
  });

  return TailscaleIdentityDiscovery.of({ discover });
});

/** Node-backed OS and DNS APIs for standalone Node and desktop runtimes */
const nodeLayer = Layer.succeed(TailscaleIdentityNode, {
  networkInterfaces: Effect.try(() => NodeOS.networkInterfaces()).pipe(
    Effect.orElseSucceed(() => ({})),
  ),
  reverseLookup: (address) =>
    Effect.tryPromise(() => NodeDnsPromises.lookupService(address, 0)).pipe(
      Effect.map(({ hostname }) => [hostname]),
      Effect.orElseSucceed(() => [] as readonly string[]),
    ),
});

/** Live passive Tailscale identity discovery */
export const layer = Layer.effect(TailscaleIdentityDiscovery, make).pipe(Layer.provide(nodeLayer));
