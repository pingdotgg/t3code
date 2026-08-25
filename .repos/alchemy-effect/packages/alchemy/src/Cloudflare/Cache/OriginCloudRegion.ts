import * as cache from "@distilled.cloud/cloudflare/cache";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Cache.OriginCloudRegion" as const;
type TypeId = typeof TypeId;

/**
 * The cloud vendor hosting an origin. Region identifiers are
 * vendor-specific — the valid set for each vendor is returned by the
 * `supported_regions` endpoint
 * (`/zones/{zone_id}/cache/origin_cloud_regions/supported_regions`).
 */
export type OriginCloudRegionVendor = "aws" | "azure" | "gcp" | "oci";

export interface OriginCloudRegionProps {
  /**
   * Zone the mapping belongs to. Stable — moving the mapping to a
   * different zone triggers a replacement.
   */
  zoneId: string;
  /**
   * Origin IP address (IPv4 or IPv6) the mapping applies to. The IP is the
   * mapping's identity within the zone, so changing it triggers a
   * replacement.
   *
   * Cloudflare normalizes the IP to canonical form before storage
   * (RFC 5952 for IPv6) — supply IPv6 addresses in canonical form so the
   * stored identity matches the prop.
   */
  ip: string;
  /**
   * Cloud vendor hosting the origin. Mutable — patched in place.
   */
  vendor: OriginCloudRegionVendor;
  /**
   * Cloud vendor region identifier, e.g. `us-east-1` for `aws`. Must be a
   * valid region for the specified vendor (see the vendor's entry in the
   * `supported_regions` endpoint). Mutable — patched in place.
   */
  region: string;
}

export interface OriginCloudRegionAttributes {
  /** Zone the mapping belongs to. */
  zoneId: string;
  /** Canonicalized origin IP the mapping applies to. */
  originIp: string;
  /** Cloud vendor hosting the origin. */
  vendor: string;
  /** Cloud vendor region identifier. */
  region: string;
  /** When the mapping was last modified, if Cloudflare reports it. */
  modifiedOn: string | undefined;
}

export type OriginCloudRegion = Resource<
  TypeId,
  OriginCloudRegionProps,
  OriginCloudRegionAttributes,
  never,
  Providers
>;

/**
 * An origin cloud-region mapping of a Cloudflare zone
 * (`/zones/{zone_id}/cache/origin_cloud_regions`).
 *
 * The mapping tells Cloudflare which public-cloud vendor region hosts a
 * given origin IP, letting Tiered Cache pick an upper-tier data center
 * close to the origin for better cache-fill performance.
 *
 * A mapping's identity is its origin IP within the zone — changing `ip`
 * (or `zoneId`) triggers a replacement, while `vendor` and `region` are
 * patched in place. Mappings carry no ownership markers: when there is no
 * prior state, `read` reports an existing mapping for the same IP as
 * `Unowned`, so the engine refuses to take it over unless `--adopt`
 * (or `adopt(true)`) is set.
 * @resource
 * @product Cache
 * @category Performance & Reliability
 * @section Mapping origins to cloud regions
 * @example Map an origin IP to an AWS region
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Cache.OriginCloudRegion("ApiOrigin", {
 *   zoneId: zone.zoneId,
 *   ip: "192.0.2.10",
 *   vendor: "aws",
 *   region: "us-east-1",
 * });
 * ```
 *
 * @example Map several origins of the same zone
 * ```typescript
 * // One resource per origin IP — the IP is the mapping's identity.
 * yield* Cloudflare.Cache.OriginCloudRegion("UsOrigin", {
 *   zoneId: zone.zoneId,
 *   ip: "192.0.2.10",
 *   vendor: "gcp",
 *   region: "us-central1",
 * });
 * yield* Cloudflare.Cache.OriginCloudRegion("EuOrigin", {
 *   zoneId: zone.zoneId,
 *   ip: "192.0.2.20",
 *   vendor: "gcp",
 *   region: "europe-west1",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cache/how-to/tiered-cache/
 */
export const OriginCloudRegion = Resource<OriginCloudRegion>(TypeId);

/**
 * Returns true if the given value is an OriginCloudRegion resource.
 */
export const isOriginCloudRegion = (
  value: unknown,
): value is OriginCloudRegion =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * Compare two origin IPs for identity. Cloudflare canonicalizes stored IPs
 * (lowercased hex groups for IPv6 per RFC 5952), so a case-insensitive
 * compare covers the common canonical-vs-uppercase drift without trying to
 * re-implement full RFC 5952 normalization.
 */
const sameIp = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export const OriginCloudRegionProvider = () =>
  Provider.succeed(OriginCloudRegion, {
    stables: ["zoneId", "originIp"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Mappings live inside a zone (`/zones/{zone_id}/origin/cloud_regions`)
      // with no account-wide list — enumerate every zone, then list its
      // mappings and flatten. A zone may have zero mappings.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          cache.listOriginCloudRegions.pages({ zoneId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((mapping) =>
                  toAttributes(zoneId, mapping),
                ),
              ),
            ),
            // Plan-gated / deleted zones reject the route; skip them.
            Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The IP is the mapping's identity — changing it replaces. Prefer the
      // canonicalized IP cached on output; fall back to resolved old props.
      const oldIp =
        output?.originIp ??
        (olds !== undefined && isResolved(olds) ? olds.ip : undefined);
      if (oldIp !== undefined && !sameIp(oldIp, news.ip)) {
        return { action: "replace" } as const;
      }
      const oldZoneId =
        output?.zoneId ??
        (olds !== undefined && isResolved(olds) ? olds.zoneId : undefined);
      if (oldZoneId !== undefined && oldZoneId !== news.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      const ip = output?.originIp ?? olds?.ip;
      if (!zoneId || !ip) return undefined;

      const observed = yield* getMapping(zoneId, ip);
      if (observed === undefined) return undefined;

      // Owned path: we have persisted attributes for this mapping.
      if (output?.originIp) return observed;

      // Adoption path: a mapping for this IP already exists but carries no
      // ownership markers — brand it `Unowned` so the engine refuses to
      // take over unless `adopt` is set.
      return Unowned(observed);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      // `output` caches the canonicalized IP; fall back to the prop.
      const ip = output?.originIp ?? news.ip;

      // 1. Observe — cloud state is authoritative; a cached output is only
      //    a hint and the mapping may be gone.
      const observed = yield* getMapping(zoneId, ip);

      // 2. Ensure + sync in one step — the endpoint is a true PUT upsert
      //    (`PUT /origin/cloud_regions/{origin_ip}`), so a missing mapping
      //    and a drifted mapping converge through the same call. Skip the
      //    API entirely on a no-op.
      if (
        observed !== undefined &&
        observed.vendor === news.vendor &&
        observed.region === news.region
      ) {
        return observed;
      }
      const upserted = yield* cache.putOriginCloudRegion({
        zoneId,
        // Path param and body `origin_ip` must match or Cloudflare rejects
        // the request with a 400.
        originIP: ip,
        originIp: ip,
        vendor: news.vendor,
        region: news.region,
      });
      return toAttributes(zoneId, upserted);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — the mapping may already be gone (typed not-found), or
      // the zone itself may have been deleted out-of-band (InvalidRoute).
      yield* cache
        .deleteOriginCloudRegion({
          zoneId: output.zoneId,
          originIP: output.originIp,
        })
        .pipe(
          Effect.catchTag("OriginCloudRegionNotFound", () => Effect.void),
          Effect.catchTag("InvalidRoute", () => Effect.void),
        );
    }),
  });

/**
 * Read a mapping by IP, mapping "gone" (typed `OriginCloudRegionNotFound`,
 * or `InvalidRoute` when the zone itself no longer routes) to `undefined`.
 */
const getMapping = (zoneId: string, ip: string) =>
  cache.getOriginCloudRegion({ zoneId, originIP: ip }).pipe(
    Effect.map((response): OriginCloudRegionAttributes | undefined =>
      toAttributes(zoneId, response),
    ),
    Effect.catchTag("OriginCloudRegionNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

const toAttributes = (
  zoneId: string,
  response:
    | cache.GetOriginCloudRegionResponse
    | cache.PutOriginCloudRegionResponse
    | cache.ListOriginCloudRegionsResponse["result"][number],
): OriginCloudRegionAttributes => ({
  zoneId,
  originIp: response.originIp,
  vendor: response.vendor,
  region: response.region,
  modifiedOn: response.modifiedOn ?? undefined,
});
