import * as dnsFirewall from "@distilled.cloud/cloudflare/dns-firewall";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.DNS.Firewall" as const;
type TypeId = typeof TypeId;

/**
 * Attack mitigation settings for a DNS Firewall cluster.
 */
export type AttackMitigation = {
  /**
   * When enabled, automatically mitigate random-prefix attacks to protect
   * upstream DNS servers.
   * @default false
   */
  enabled?: boolean;
  /**
   * Only mitigate attacks when upstream servers seem unhealthy.
   * @default false
   */
  onlyWhenUpstreamUnhealthy?: boolean;
};

export type FirewallProps = {
  /**
   * DNS Firewall cluster name. Changing the name triggers a replacement —
   * the name is the identity used for cold-state recovery. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Upstream DNS server IPs the cluster forwards queries to. At least one
   * is required.
   */
  upstreamIps: string[];
  /**
   * Attack mitigation settings.
   * @default disabled
   */
  attackMitigation?: AttackMitigation;
  /**
   * Whether to refuse to answer queries for the ANY type.
   * @default false
   */
  deprecateAnyRequests?: boolean;
  /**
   * Whether to forward the client IP (resolver) subnet if no EDNS Client
   * Subnet is sent.
   * @default false
   */
  ecsFallback?: boolean;
  /**
   * Upper bound (in seconds) on how long responses are cached, regardless
   * of the TTL received from the upstream nameservers.
   * @default 900
   */
  maximumCacheTtl?: number;
  /**
   * Lower bound (in seconds) on how long responses are cached, regardless
   * of the TTL received from the upstream nameservers.
   * @default 60
   */
  minimumCacheTtl?: number;
  /**
   * How long (in seconds) DNS Firewall caches negative responses (e.g.
   * NXDOMAIN) from the upstream servers. `null` uses Cloudflare's default
   * behavior.
   * @default null
   */
  negativeCacheTtl?: number | null;
  /**
   * Ratelimit in queries per second per datacenter, applied to queries
   * sent to the upstream nameservers. `null` disables the limit.
   * @default null
   */
  ratelimit?: number | null;
  /**
   * Number of retries for fetching DNS responses from upstream nameservers
   * (not counting the initial attempt).
   * @default 2
   */
  retries?: number;
  /**
   * Reverse DNS (PTR) mappings for the cluster's assigned IPs — a map of
   * cluster IP address to PTR record content. Only the entries listed here
   * are managed: entries are upserted, and removing an entry from this map
   * leaves the PTR in place (clear it explicitly with an empty string).
   */
  reverseDns?: Record<string, string>;
};

export type FirewallAttributes = {
  /**
   * DNS Firewall cluster identifier (UUID).
   */
  dnsFirewallId: string;
  /**
   * The Cloudflare account the cluster belongs to.
   */
  accountId: string;
  /**
   * DNS Firewall cluster name.
   */
  name: string;
  /**
   * The Cloudflare-assigned anycast IPs of the cluster. Point NS glue
   * records at these.
   */
  dnsFirewallIps: string[];
  /**
   * Upstream DNS server IPs the cluster forwards queries to.
   */
  upstreamIps: string[];
  /**
   * Attack mitigation settings.
   */
  attackMitigation: {
    enabled: boolean;
    onlyWhenUpstreamUnhealthy: boolean;
  };
  /**
   * Whether queries for the ANY type are refused.
   */
  deprecateAnyRequests: boolean;
  /**
   * Whether the client IP (resolver) subnet is forwarded when no EDNS
   * Client Subnet is sent.
   */
  ecsFallback: boolean;
  /**
   * Upper bound (in seconds) on response cache duration.
   */
  maximumCacheTtl: number;
  /**
   * Lower bound (in seconds) on response cache duration.
   */
  minimumCacheTtl: number;
  /**
   * Negative response cache duration (in seconds), or `null` for
   * Cloudflare's default behavior.
   */
  negativeCacheTtl: number | null;
  /**
   * Ratelimit in queries per second per datacenter, or `null` when
   * disabled.
   */
  ratelimit: number | null;
  /**
   * Number of retries for fetching DNS responses from upstream
   * nameservers.
   */
  retries: number;
  /**
   * Reverse DNS (PTR) mappings managed on the cluster, when the
   * `reverseDns` prop is set.
   */
  reverseDns: Record<string, string> | undefined;
  /**
   * Last modification time of the cluster.
   */
  modifiedOn: string;
};

export type Firewall = Resource<
  TypeId,
  FirewallProps,
  FirewallAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare DNS Firewall cluster.
 *
 * DNS Firewall sits in front of your authoritative DNS infrastructure,
 * caching responses on Cloudflare's anycast network and shielding the
 * upstream nameservers from attack traffic. Creating a cluster assigns a
 * set of Cloudflare anycast IPs (`dnsFirewallIps`) that you point NS glue
 * records at; queries hitting those IPs are answered from cache or
 * forwarded to your `upstreamIps`.
 *
 * DNS Firewall is a paid add-on (typically Enterprise / contract). On
 * accounts without the entitlement, creation fails with the typed
 * `DnsFirewallNotEntitled` error (Cloudflare error code 10101).
 *
 * All settings are mutable in place; only `name` (the cold-state recovery
 * identity) triggers a replacement.
 * @resource
 * @product DNS Firewall
 * @category Domains & DNS
 * @section Creating a Cluster
 * @example Basic cluster
 * ```typescript
 * const cluster = yield* Cloudflare.DNS.Firewall("dns-shield", {
 *   upstreamIps: ["192.0.2.1", "192.0.2.2"],
 * });
 * // Point NS glue records at the assigned anycast IPs:
 * const ips = cluster.dnsFirewallIps;
 * ```
 *
 * @example Tuned caching and attack mitigation
 * ```typescript
 * const cluster = yield* Cloudflare.DNS.Firewall("dns-shield", {
 *   upstreamIps: ["192.0.2.1"],
 *   minimumCacheTtl: 120,
 *   maximumCacheTtl: 3600,
 *   negativeCacheTtl: 300,
 *   ratelimit: 600,
 *   retries: 2,
 *   attackMitigation: {
 *     enabled: true,
 *     onlyWhenUpstreamUnhealthy: true,
 *   },
 * });
 * ```
 *
 * @section Reverse DNS
 * @example Managing PTR records for cluster IPs
 * ```typescript
 * const cluster = yield* Cloudflare.DNS.Firewall("dns-shield", {
 *   upstreamIps: ["192.0.2.1"],
 *   reverseDns: {
 *     "203.0.113.1": "ns1.example.com",
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/dns-firewall/
 */
export const Firewall = Resource<Firewall>(TypeId, {
  aliases: ["Cloudflare.DnsFirewall"],
});

/**
 * Returns true if the given value is a DnsFirewall resource.
 */
export const isFirewall = (value: unknown): value is Firewall =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const FirewallProvider = () =>
  Provider.succeed(Firewall, {
    stables: ["dnsFirewallId", "accountId", "dnsFirewallIps"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The name is the cold-state recovery identity — renames replace.
      const oldName = output?.name ?? (yield* createClusterName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (name !== oldName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.dnsFirewallId) {
        const observed = yield* getCluster(acct, output.dnsFirewallId);
        if (!observed) return undefined;
        const reverseDns =
          olds?.reverseDns !== undefined
            ? yield* getReverseDns(acct, observed.id)
            : undefined;
        return toAttributes(observed, acct, reverseDns);
      }

      // Cold read — recover from lost state by matching the deterministic
      // physical name. Cluster names are not guaranteed unique and carry
      // no ownership markers, so report the match as `Unowned`: the
      // engine refuses to take it over unless `adopt` is set.
      const name = yield* createClusterName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (!match) return undefined;
      const reverseDns =
        olds?.reverseDns !== undefined
          ? yield* getReverseDns(acct, match.id)
          : undefined;
      return Unowned(toAttributes(match, acct, reverseDns));
    }),
    list: Effect.fn(function* () {
      // Account-scoped collection: exhaustively paginate the DNS Firewall
      // list for the ambient account. Each list item already carries the
      // full cluster shape (identical to `getDnsFirewall`), so it maps
      // directly into the `read` Attributes shape — no per-item hydration
      // needed. `reverseDns` is left `undefined` (the same shape `read`
      // produces when no managed PTR map is tracked).
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* dnsFirewall.listDnsFirewalls.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            page.result.map((cluster) =>
              toAttributes({ ...cluster, accountId }, accountId, undefined),
            ),
          ),
        ),
      );
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Prefer the deployed name: regenerating would rename the deployed
      // cluster if the generator's output for this id ever drifts.
      const name = output?.name ?? (yield* createClusterName(id, news.name));

      // Observe — the id cached on `output` is a hint, not a guarantee: a
      // missing cluster falls through to "missing" and we recreate.
      const observed = output?.dnsFirewallId
        ? yield* getCluster(output.accountId ?? accountId, output.dnsFirewallId)
        : undefined;

      let synced: ObservedCluster;
      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the
        // full desired body. Names are not unique on Cloudflare's side,
        // so there is no AlreadyExists race to tolerate.
        const created = yield* dnsFirewall.createDnsFirewall({
          accountId,
          name,
          upstreamIps: news.upstreamIps,
          attackMitigation: news.attackMitigation,
          deprecateAnyRequests: news.deprecateAnyRequests,
          ecsFallback: news.ecsFallback,
          maximumCacheTtl: news.maximumCacheTtl,
          minimumCacheTtl: news.minimumCacheTtl,
          negativeCacheTtl: news.negativeCacheTtl,
          ratelimit: news.ratelimit,
          retries: news.retries,
        });
        synced = { ...created, accountId };
      } else {
        // Sync — diff observed cloud state against the desired settings
        // (props with their documented defaults applied) and PATCH only
        // when something actually differs.
        const desired = {
          name,
          upstreamIps: news.upstreamIps,
          attackMitigation: {
            enabled: news.attackMitigation?.enabled ?? false,
            onlyWhenUpstreamUnhealthy:
              news.attackMitigation?.onlyWhenUpstreamUnhealthy ?? false,
          },
          deprecateAnyRequests: news.deprecateAnyRequests ?? false,
          ecsFallback: news.ecsFallback ?? false,
          maximumCacheTtl: news.maximumCacheTtl ?? 900,
          minimumCacheTtl: news.minimumCacheTtl ?? 60,
          negativeCacheTtl: news.negativeCacheTtl ?? null,
          ratelimit: news.ratelimit ?? null,
          retries: news.retries ?? 2,
        };
        const observedMitigation = normalizeMitigation(
          observed.attackMitigation,
        );
        const dirty =
          observed.name !== desired.name ||
          !sameIps(observed.upstreamIps, desired.upstreamIps) ||
          observedMitigation.enabled !== desired.attackMitigation.enabled ||
          observedMitigation.onlyWhenUpstreamUnhealthy !==
            desired.attackMitigation.onlyWhenUpstreamUnhealthy ||
          observed.deprecateAnyRequests !== desired.deprecateAnyRequests ||
          observed.ecsFallback !== desired.ecsFallback ||
          observed.maximumCacheTtl !== desired.maximumCacheTtl ||
          observed.minimumCacheTtl !== desired.minimumCacheTtl ||
          observed.negativeCacheTtl !== desired.negativeCacheTtl ||
          observed.ratelimit !== desired.ratelimit ||
          observed.retries !== desired.retries;

        synced = dirty
          ? {
              ...(yield* dnsFirewall.patchDnsFirewall({
                accountId: observed.accountId,
                dnsFirewallId: observed.id,
                ...desired,
              })),
              accountId: observed.accountId,
            }
          : observed;
      }

      // Sync reverse DNS (PTR) entries when managed. Only the entries in
      // the desired map are reconciled — observed entries outside the map
      // are left untouched.
      let reverseDns: Record<string, string> | undefined;
      if (news.reverseDns !== undefined) {
        const observedPtr = yield* getReverseDns(synced.accountId, synced.id);
        const dirtyPtr = Object.entries(news.reverseDns).some(
          ([ip, ptr]) => observedPtr[ip] !== ptr,
        );
        if (dirtyPtr) {
          yield* dnsFirewall.patchReverseDn({
            accountId: synced.accountId,
            dnsFirewallId: synced.id,
            ptr: news.reverseDns,
          });
        }
        reverseDns = { ...observedPtr, ...news.reverseDns };
      }

      return toAttributes(synced, synced.accountId, reverseDns);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* dnsFirewall
        .deleteDnsFirewall({
          accountId: output.accountId,
          dnsFirewallId: output.dnsFirewallId,
        })
        .pipe(Effect.catchTag("DnsFirewallNotFound", () => Effect.void));
    }),
  });

type ObservedCluster = dnsFirewall.GetDnsFirewallResponse & {
  accountId: string;
};

/**
 * Read a cluster by id, mapping "gone" (`DnsFirewallNotFound`, Cloudflare
 * error code 11001) to `undefined`.
 */
const getCluster = (accountId: string, dnsFirewallId: string) =>
  dnsFirewall.getDnsFirewall({ accountId, dnsFirewallId }).pipe(
    Effect.map((c): ObservedCluster => ({ ...c, accountId })),
    Effect.catchTag("DnsFirewallNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Read the reverse DNS (PTR) map of a cluster, narrowing the distilled
 * `Record<string, unknown>` values to strings.
 */
const getReverseDns = (accountId: string, dnsFirewallId: string) =>
  dnsFirewall
    .getReverseDn({ accountId, dnsFirewallId })
    .pipe(
      Effect.map((r) =>
        Object.fromEntries(
          Object.entries(r.ptr).flatMap(([ip, ptr]) =>
            typeof ptr === "string" && ptr !== "" ? [[ip, ptr]] : [],
          ),
        ),
      ),
    );

/**
 * Find a cluster by exact name. The list API has no name filter, so scan
 * the (paginated) account list client-side. If several clusters carry the
 * same name, pick the lexicographically smallest id for determinism.
 */
const findByName = (accountId: string, name: string) =>
  dnsFirewall.listDnsFirewalls.items({ accountId }).pipe(
    Stream.filter((c) => c.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => a.id.localeCompare(b.id))
        .at(0),
    ),
    Effect.map((match) =>
      match ? ({ ...match, accountId } satisfies ObservedCluster) : undefined,
    ),
  );

const createClusterName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const normalizeMitigation = (
  mitigation: dnsFirewall.GetDnsFirewallResponse["attackMitigation"],
) => ({
  enabled: mitigation?.enabled ?? false,
  onlyWhenUpstreamUnhealthy: mitigation?.onlyWhenUpstreamUnhealthy ?? false,
});

const sameIps = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  cluster: ObservedCluster,
  accountId: string,
  reverseDns: Record<string, string> | undefined,
): FirewallAttributes => ({
  dnsFirewallId: cluster.id,
  accountId,
  name: cluster.name,
  dnsFirewallIps: [...cluster.dnsFirewallIps],
  upstreamIps: [...cluster.upstreamIps],
  attackMitigation: normalizeMitigation(cluster.attackMitigation),
  deprecateAnyRequests: cluster.deprecateAnyRequests,
  ecsFallback: cluster.ecsFallback,
  maximumCacheTtl: cluster.maximumCacheTtl,
  minimumCacheTtl: cluster.minimumCacheTtl,
  negativeCacheTtl: cluster.negativeCacheTtl,
  ratelimit: cluster.ratelimit,
  retries: cluster.retries,
  reverseDns,
  modifiedOn: cluster.modifiedOn,
});
