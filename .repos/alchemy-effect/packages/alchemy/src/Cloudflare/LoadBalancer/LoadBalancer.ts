import * as loadBalancers from "@distilled.cloud/cloudflare/load-balancers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.LoadBalancer.LoadBalancer" as const;
type TypeId = typeof TypeId;

/**
 * Steering policy for a Load Balancer.
 */
export type SteeringPolicy =
  | "off"
  | "geo"
  | "random"
  | "dynamic_latency"
  | "proximity"
  | "least_outstanding_requests"
  | "least_connections"
  | "";

/**
 * Session affinity mode for a Load Balancer.
 */
export type SessionAffinity = "none" | "cookie" | "ip_cookie" | "header";

/**
 * Session affinity attributes for a Load Balancer.
 */
export interface SessionAffinityAttributes {
  /** Seconds to drain an origin of affine sessions before removal. */
  drainDuration?: number;
  /** Headers to base header-mode session affinity on. */
  headers?: ReadonlyArray<string>;
  /** Whether all configured headers must match. */
  requireAllHeaders?: boolean;
  /** SameSite attribute of the affinity cookie. */
  samesite?: "Auto" | "Lax" | "None" | "Strict";
  /** Secure attribute of the affinity cookie. */
  secure?: "Auto" | "Always" | "Never";
  /** Failover behavior when an affine origin becomes unavailable. */
  zeroDowntimeFailover?: "none" | "temporary" | "sticky";
}

/**
 * Location strategy for non-proxied (DNS-steered) Load Balancers.
 */
export interface LocationStrategy {
  /** Resolution mode used to determine the client's location. */
  mode?: "pop" | "resolver_ip";
  /** When to prefer the EDNS Client Subnet over the resolver IP. */
  preferEcs?: "always" | "never" | "proximity" | "geo";
}

export interface Props {
  /**
   * Zone the load balancer lives in. Stable — changing the zone triggers
   * replacement.
   */
  zoneId: string;
  /**
   * The DNS hostname to associate with the Load Balancer (e.g.
   * `lb.example.com`). If this hostname already exists as a DNS record,
   * the Load Balancer takes precedence. Mutable in place.
   */
  name: string;
  /**
   * Pool IDs ordered by their failover priority. Used by default, or when
   * region/country/PoP pools are not configured for a request.
   */
  defaultPools: ReadonlyArray<string>;
  /**
   * The pool ID to use when all other pools are detected as unhealthy.
   */
  fallbackPool: string;
  /**
   * Object description.
   */
  description?: string;
  /**
   * Whether the hostname is gray clouded (false) or orange clouded /
   * proxied through Cloudflare (true).
   * @default false
   */
  proxied?: boolean;
  /**
   * TTL (seconds) of the DNS entry for the IP address returned by this
   * load balancer. Only applies to unproxied load balancers — the API
   * rejects it when `proxied: true`.
   * @default 30
   */
  ttl?: number;
  /**
   * Steering policy for this load balancer.
   * @default ""
   */
  steeringPolicy?: SteeringPolicy;
  /**
   * Type of session affinity to use.
   * @default "none"
   */
  sessionAffinity?: SessionAffinity;
  /**
   * Time, in seconds, until a client's session expires after being
   * created.
   * @default 82800
   */
  sessionAffinityTtl?: number;
  /**
   * Attributes configuring session affinity behavior.
   */
  sessionAffinityAttributes?: SessionAffinityAttributes;
  /**
   * Routing modifications in response to dynamic conditions (e.g.
   * zero-downtime failover between health probes).
   */
  adaptiveRouting?: { failoverAcrossPools?: boolean };
  /**
   * Location-based steering behavior for non-proxied requests.
   */
  locationStrategy?: LocationStrategy;
  /**
   * Pool weights for `random` / `least_outstanding_requests` /
   * `least_connections` steering.
   */
  randomSteering?: {
    defaultWeight?: number;
    poolWeights?: Record<string, number>;
  };
  /**
   * Region code → ordered pool IDs for that region. Regions not defined
   * fall back to `defaultPools`.
   */
  regionPools?: Record<string, ReadonlyArray<string>>;
  /**
   * Country code → ordered pool IDs for that country. Countries not
   * defined fall back to the corresponding region pool mapping.
   */
  countryPools?: Record<string, ReadonlyArray<string>>;
  /**
   * Enterprise only — Cloudflare PoP identifier → ordered pool IDs for
   * that PoP.
   */
  popPools?: Record<string, ReadonlyArray<string>>;
}

export interface Attributes {
  /** Cloudflare-assigned load balancer identifier. */
  loadBalancerId: string;
  /** Zone that owns the load balancer. */
  zoneId: string;
  /** DNS hostname of the load balancer. */
  name: string;
  /** Whether the load balancer is enabled. */
  enabled: boolean;
  /** Whether the hostname is proxied (orange clouded). */
  proxied: boolean;
  /** Resolved steering policy. */
  steeringPolicy: string;
  /** Resolved default pool ids. */
  defaultPools: ReadonlyArray<string>;
  /** Resolved fallback pool id. */
  fallbackPool: string;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type LoadBalancer = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * A Cloudflare Load Balancer — a zone-level DNS hostname that distributes
 * traffic across {@link Pool}s with health-based failover,
 * geo/latency steering, and session affinity.
 *
 * Requires the Load Balancing subscription to be enabled for the zone;
 * without it, creation fails with the typed `LoadBalancingNotEnabledForZone`
 * error.
 * @resource
 * @product Load Balancers
 * @category Performance & Reliability
 * @section Creating a Load Balancer
 * @example DNS-only (unproxied) load balancer
 * ```typescript
 * const lb = yield* Cloudflare.LoadBalancer.LoadBalancer("ApiLb", {
 *   zoneId: zone.zoneId,
 *   name: "api.example.com",
 *   defaultPools: [pool.poolId],
 *   fallbackPool: pool.poolId,
 *   proxied: false,
 *   ttl: 30,
 * });
 * ```
 *
 * @example Proxied load balancer with steering and affinity
 * ```typescript
 * const lb = yield* Cloudflare.LoadBalancer.LoadBalancer("AppLb", {
 *   zoneId: zone.zoneId,
 *   name: "app.example.com",
 *   defaultPools: [primary.poolId, secondary.poolId],
 *   fallbackPool: secondary.poolId,
 *   proxied: true,
 *   steeringPolicy: "random",
 *   sessionAffinity: "cookie",
 * });
 * ```
 *
 * @section Geo steering
 * @example Region pools
 * ```typescript
 * yield* Cloudflare.LoadBalancer.LoadBalancer("GeoLb", {
 *   zoneId: zone.zoneId,
 *   name: "geo.example.com",
 *   defaultPools: [us.poolId],
 *   fallbackPool: us.poolId,
 *   steeringPolicy: "geo",
 *   regionPools: {
 *     WEU: [eu.poolId],
 *     ENAM: [us.poolId],
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/load-balancing/
 */
export const LoadBalancer = Resource<LoadBalancer>(TypeId, {
  aliases: ["Cloudflare.LoadBalancer"],
});

/**
 * Returns true if the given value is a LoadBalancer resource.
 */
export const isLoadBalancer = (value: unknown): value is LoadBalancer =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const LoadBalancerProvider = () =>
  Provider.succeed(LoadBalancer, {
    stables: ["loadBalancerId", "zoneId", "createdOn"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // zoneId is Input<string>; by diff time both sides are concrete
      // strings when statically known.
      if (
        typeof olds.zoneId === "string" &&
        typeof news.zoneId === "string" &&
        olds.zoneId !== news.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      if (output?.loadBalancerId) {
        const observed = yield* getLoadBalancer(
          output.zoneId,
          output.loadBalancerId,
        );
        return observed ? toAttributes(observed, output.zoneId) : undefined;
      }
      // Cold read — a load balancer's hostname is unique within its zone.
      // Load balancers carry no ownership marker, so report the match as
      // Unowned and let the engine gate takeover behind --adopt.
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      const name = output?.name ?? olds?.name;
      if (zoneId && name) {
        const match = yield* findByName(zoneId, name);
        if (match?.id) {
          const observed = yield* getLoadBalancer(zoneId, match.id);
          if (observed) return Unowned(toAttributes(observed, zoneId));
        }
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const body = buildBody(news);

      // 1. Observe — output.loadBalancerId is a cache hint; a 404 falls
      //    through to "missing" and we recreate.
      const observed = output?.loadBalancerId
        ? yield* getLoadBalancer(output.zoneId ?? zoneId, output.loadBalancerId)
        : undefined;

      // 2. Ensure — missing: create with the full desired body.
      if (!observed?.id) {
        const created = yield* loadBalancers.createLoadBalancer({
          zoneId,
          ...body,
        });
        return toAttributes(created, zoneId);
      }

      // 3. Sync — the update endpoint is a PUT requiring the full body;
      //    diff observed against desired and skip the call on a no-op.
      if (!loadBalancerDirty(observed, body)) {
        return toAttributes(observed, zoneId);
      }
      const updated = yield* loadBalancers.updateLoadBalancer({
        zoneId,
        loadBalancerId: observed.id,
        ...body,
      });
      return toAttributes(updated, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* loadBalancers
        .deleteLoadBalancer({
          zoneId: output.zoneId,
          loadBalancerId: output.loadBalancerId,
        })
        .pipe(Effect.catchTag("LoadBalancerNotFound", () => Effect.void));
    }),

    // Load balancers are zone-scoped; enumerate every zone in the account and
    // exhaustively paginate each zone's load balancers, hydrating each into the
    // same Attributes shape `read` returns. Zones without the Load Balancing
    // subscription reject the route (Forbidden) and are skipped.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          loadBalancers.listLoadBalancers.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((lb) => toAttributes(lb, zone.id)),
              ),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

type ObservedLoadBalancer =
  | loadBalancers.GetLoadBalancerResponse
  | loadBalancers.CreateLoadBalancerResponse
  | loadBalancers.UpdateLoadBalancerResponse
  | loadBalancers.ListLoadBalancersResponse["result"][number];

/**
 * Read a load balancer by id, mapping "gone" (`LoadBalancerNotFound`,
 * HTTP 404 code 1001) to `undefined`.
 */
const getLoadBalancer = (zoneId: string, loadBalancerId: string) =>
  loadBalancers
    .getLoadBalancer({ zoneId, loadBalancerId })
    .pipe(
      Effect.catchTag("LoadBalancerNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find a load balancer by exact hostname within a zone.
 */
const findByName = (zoneId: string, name: string) =>
  loadBalancers.listLoadBalancers.items({ zoneId }).pipe(
    Stream.filter((lb) => lb.name === name),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).at(0)),
  );

const resolvePools = (
  pools: Record<string, ReadonlyArray<Input<string>>> | undefined,
): Record<string, unknown> | undefined =>
  pools === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(pools).map(([k, v]) => [k, v as string[]]),
      );

const buildBody = (news: Props) => ({
  name: news.name,
  defaultPools: news.defaultPools as string[],
  fallbackPool: news.fallbackPool as string,
  description: news.description,
  proxied: news.proxied,
  ttl: news.proxied === true ? undefined : news.ttl,
  steeringPolicy: news.steeringPolicy,
  sessionAffinity: news.sessionAffinity,
  sessionAffinityTtl: news.sessionAffinityTtl,
  sessionAffinityAttributes:
    news.sessionAffinityAttributes === undefined
      ? undefined
      : {
          ...news.sessionAffinityAttributes,
          headers:
            news.sessionAffinityAttributes.headers === undefined
              ? undefined
              : Array.from(news.sessionAffinityAttributes.headers),
        },
  adaptiveRouting: news.adaptiveRouting,
  locationStrategy: news.locationStrategy,
  randomSteering: news.randomSteering,
  regionPools: resolvePools(news.regionPools),
  countryPools: resolvePools(news.countryPools),
  popPools: resolvePools(news.popPools),
});

/**
 * Compare desired (explicitly set) fields against observed cloud state.
 * Unset desired fields defer to whatever the cloud already has.
 */
const loadBalancerDirty = (
  observed: ObservedLoadBalancer,
  body: ReturnType<typeof buildBody>,
): boolean => {
  const scalarDirty = (
    desired: string | number | boolean | undefined,
    actual: string | number | boolean | null | undefined,
  ) => desired !== undefined && desired !== (actual ?? undefined);
  const structDirty = (desired: unknown, actual: unknown) =>
    desired !== undefined &&
    JSON.stringify(desired) !== JSON.stringify(actual ?? {});

  return (
    (observed.name ?? "") !== body.name ||
    JSON.stringify(observed.defaultPools ?? []) !==
      JSON.stringify(body.defaultPools) ||
    (observed.fallbackPool ?? "") !== body.fallbackPool ||
    scalarDirty(body.description, observed.description) ||
    scalarDirty(body.proxied, observed.proxied) ||
    scalarDirty(body.ttl, observed.ttl) ||
    scalarDirty(body.steeringPolicy, observed.steeringPolicy) ||
    scalarDirty(body.sessionAffinity, observed.sessionAffinity) ||
    scalarDirty(body.sessionAffinityTtl, observed.sessionAffinityTtl) ||
    structDirty(
      body.sessionAffinityAttributes,
      observed.sessionAffinityAttributes,
    ) ||
    structDirty(body.adaptiveRouting, observed.adaptiveRouting) ||
    structDirty(body.locationStrategy, observed.locationStrategy) ||
    structDirty(body.randomSteering, observed.randomSteering) ||
    structDirty(body.regionPools, observed.regionPools) ||
    structDirty(body.countryPools, observed.countryPools) ||
    structDirty(body.popPools, observed.popPools)
  );
};

const toAttributes = (
  lb: ObservedLoadBalancer,
  zoneId: string,
): Attributes => ({
  loadBalancerId: lb.id ?? "",
  zoneId,
  name: lb.name ?? "",
  enabled: lb.enabled ?? true,
  proxied: lb.proxied ?? false,
  steeringPolicy: lb.steeringPolicy ?? "",
  defaultPools: [...(lb.defaultPools ?? [])],
  fallbackPool: lb.fallbackPool ?? "",
  createdOn: lb.createdOn ?? undefined,
  modifiedOn: lb.modifiedOn ?? undefined,
});
