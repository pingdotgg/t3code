import * as customHostnames from "@distilled.cloud/cloudflare/custom-hostnames";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

export interface FallbackOriginProps {
  /**
   * Zone the fallback origin belongs to. Stable — a zone has exactly one
   * fallback origin, so changing the zone triggers replacement.
   */
  zoneId: string;
  /**
   * Your origin hostname that requests to custom hostnames are sent to.
   * Must be a DNS record (A, AAAA or CNAME) within the zone — create the
   * `Cloudflare.DNS.Record` first and pass its name.
   *
   * Mutable — the API is a PUT-style upsert.
   */
  origin: string;
}

export interface FallbackOriginAttributes {
  /** Zone that owns this fallback origin. */
  zoneId: string;
  /** The configured origin hostname. */
  origin: string;
  /**
   * Activation status (`initializing`, `pending_deployment`, `active`,
   * …). Deployment is asynchronous (typically minutes) and is not
   * blocked on.
   */
  status: string | undefined;
}

export type FallbackOrigin = Resource<
  "Cloudflare.CustomHostname.FallbackOrigin",
  FallbackOriginProps,
  FallbackOriginAttributes,
  never,
  Providers
>;

/**
 * The Cloudflare for SaaS fallback origin of a zone.
 *
 * A zone-level singleton: requests to any of the zone's custom hostnames
 * that don't have a `customOriginServer` are routed to this origin.
 * Setting a fallback origin implicitly enables Cloudflare for SaaS on
 * the zone.
 *
 * Safety: when there is no prior state, `read` reports an existing
 * fallback origin as `Unowned`, so the engine refuses to overwrite an
 * out-of-band configuration unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Custom Hostnames
 * @category Domains & DNS
 * @section Setting the Fallback Origin
 * @example Point custom hostname traffic at your origin
 * ```typescript
 * const record = yield* Cloudflare.DNS.Record("Origin", {
 *   zoneId: zone.zoneId,
 *   name: "origin.my-saas.com",
 *   type: "A",
 *   content: "203.0.113.1",
 *   proxied: true,
 * });
 * const fallback = yield* Cloudflare.CustomHostname.FallbackOrigin("Fallback", {
 *   zoneId: zone.zoneId,
 *   origin: record.name,
 * });
 * ```
 */
export const FallbackOrigin = Resource<FallbackOrigin>(
  "Cloudflare.CustomHostname.FallbackOrigin",
  { aliases: ["Cloudflare.FallbackOrigin"] },
);

export const isFallbackOrigin = (value: unknown): value is FallbackOrigin =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.CustomHostname.FallbackOrigin";

export const FallbackOriginProvider = () =>
  Provider.succeed(FallbackOrigin, {
    stables: ["zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Zone singleton — no account-wide list. Enumerate every zone and
      // read its fallback origin; zones without one configured (or
      // without Cloudflare for SaaS access) are skipped.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          observeFallbackOrigin(zoneId).pipe(
            Effect.map((observed): FallbackOriginAttributes | undefined => {
              if (
                observed?.origin === undefined ||
                observed.status === "pending_deletion" ||
                observed.status === "deletion_timed_out"
              ) {
                return undefined;
              }
              return {
                zoneId,
                origin: observed.origin,
                status: observed.status,
              };
            }),
            // Zones without Cloudflare for SaaS entitlement reject the
            // route; skip them rather than failing the whole enumeration.
            Effect.catchTag(["SaasAccessNotGranted", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is FallbackOriginAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as FallbackOriginProps;
      const n = news as FallbackOriginProps;
      // zoneId is Input<string>; compare only once both sides are
      // concrete strings.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const origin = news.origin as string;

      // 1. Observe the singleton.
      const observed = yield* observeFallbackOrigin(zoneId);

      // 2/3. Ensure + sync — PUT is a true upsert; skip the API call
      //      entirely when the observed origin already matches (the
      //      status field converges asynchronously on its own).
      if (
        observed?.origin === origin &&
        observed.status !== "pending_deletion" &&
        observed.status !== "deletion_timed_out"
      ) {
        return { zoneId, origin: observed.origin, status: observed.status };
      }
      const updated = yield* customHostnames.putFallbackOrigin({
        zoneId,
        origin,
      });

      // 4. Return fresh attributes.
      return {
        zoneId,
        origin: updated.origin ?? origin,
        status: updated.status ?? undefined,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* customHostnames
        .deleteFallbackOrigin({ zoneId: output.zoneId })
        .pipe(Effect.catchTag("FallbackOriginNotFound", () => Effect.void));
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (!zoneId) return undefined;
      const observed = yield* observeFallbackOrigin(zoneId);
      if (
        observed?.origin === undefined ||
        observed.status === "pending_deletion" ||
        observed.status === "deletion_timed_out"
      ) {
        return undefined;
      }
      const attrs: FallbackOriginAttributes = {
        zoneId,
        origin: observed.origin,
        status: observed.status,
      };
      // Owned path: we have persisted state — refresh it. Cold path: a
      // fallback origin exists but we cannot prove we created it (the
      // API has no ownership markers), so gate takeover behind adoption.
      return output?.zoneId ? attrs : Unowned(attrs);
    }),
  });

interface ObservedFallbackOrigin {
  readonly origin: string | undefined;
  readonly status: string | undefined;
}

// An unset fallback origin is reported by the API as a bare 404 —
// typed in the distilled union as `FallbackOriginNotFound`.
const observeFallbackOrigin = (zoneId: string) =>
  customHostnames.getFallbackOrigin({ zoneId }).pipe(
    Effect.map(
      (r): ObservedFallbackOrigin => ({
        origin: r.origin ?? undefined,
        status: r.status ?? undefined,
      }),
    ),
    Effect.catchTag("FallbackOriginNotFound", () => Effect.succeed(undefined)),
  );
