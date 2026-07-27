import * as cache from "@distilled.cloud/cloudflare/cache";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Cache.RegionalTieredCache" as const;
type TypeId = typeof TypeId;

export interface RegionalTieredCacheProps {
  /**
   * Zone whose Regional Tiered Cache setting is managed. Stable —
   * changing the zone triggers a replacement (the old zone's setting is
   * restored to the value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Regional Tiered Cache is enabled on the zone (`value: "on"`)
   * or disabled (`value: "off"`). Mutable — patched in place.
   * @default true
   */
  enabled?: boolean;
}

export interface RegionalTieredCacheAttributes {
  /** Zone the setting belongs to. */
  zoneId: string;
  /** Resolved current value of the setting (`"on"` or `"off"`). */
  value: string;
  /**
   * Whether the setting can be modified on the zone's current plan
   * (`false` means the setting is plan-gated).
   */
  editable: boolean;
  /** When the setting was last modified, if Cloudflare reports it. */
  modifiedOn: string | undefined;
  /**
   * The value the setting had before Alchemy first patched it. Restored
   * on destroy, so deleting the resource puts the zone back the way it
   * was found.
   */
  initialValue: string;
}

export type RegionalTieredCache = Resource<
  TypeId,
  RegionalTieredCacheProps,
  RegionalTieredCacheAttributes,
  never,
  Providers
>;

/**
 * The Regional Tiered Cache setting of a Cloudflare zone
 * (`/zones/{zone_id}/cache/regional_tiered_cache`).
 *
 * Regional Tiered Cache adds a regional layer between Cloudflare's lower
 * tiers and the upper-tier data center, so cache misses in a region only
 * travel to the regional hub instead of crossing the globe. The setting is
 * a zone **singleton** — it always exists on entitled zones (default
 * `off`), so this resource never creates or deletes anything physical.
 * Reconcile patches the setting when the observed value differs from the
 * desired one; destroy restores the value the setting had before Alchemy
 * first managed it (captured as `initialValue`).
 *
 * **Plan-gated**: Regional Tiered Cache requires an Enterprise zone. On
 * lower plans both reads and writes fail with Cloudflare error code 1135
 * ("this zone setting is not available for your plan type"), surfaced as
 * the typed `SettingUnavailableForPlan` error.
 *
 * Only one `RegionalTieredCache` resource per zone makes sense — two
 * instances managing the same zone would fight over the singleton.
 * @resource
 * @product Cache
 * @category Performance & Reliability
 * @section Managing Regional Tiered Cache
 * @example Enable Regional Tiered Cache on an Enterprise zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Cache.RegionalTieredCache("RegionalCache", {
 *   zoneId: zone.zoneId,
 * });
 * ```
 *
 * @example Explicitly disable Regional Tiered Cache
 * ```typescript
 * yield* Cloudflare.Cache.RegionalTieredCache("RegionalCache", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cache/how-to/tiered-cache/#regional-tiered-cache
 */
export const RegionalTieredCache = Resource<RegionalTieredCache>(TypeId);

/**
 * Returns true if the given value is a RegionalTieredCache resource.
 */
export const isRegionalTieredCache = (
  value: unknown,
): value is RegionalTieredCache =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

const desiredValue = (props: RegionalTieredCacheProps): "on" | "off" =>
  (props.enabled ?? true) ? "on" : "off";

// Cloudflare can transiently fail to authenticate a valid token, surfacing as
// `Unauthorized`/`Forbidden`. Retry with exponential backoff capped at 5s,
// bounded to ~8 attempts so a persistently-failing call still fails fast.
const transientAuthRetrySchedule = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("5 seconds"),
  ]),
  Schedule.recurs(8),
]);

export const RegionalTieredCacheProvider = () =>
  Provider.succeed(RegionalTieredCache, {
    stables: ["zoneId", "initialValue"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting. Regional Tiered Cache
      // is Enterprise-only, so non-entitled zones reject the route with
      // the typed `SettingUnavailableForPlan` error and are skipped.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          cache.getRegionalTieredCache({ zoneId }).pipe(
            // Cloudflare intermittently rejects a *valid* token with
            // `Unauthorized`/`Forbidden` (a transient edge auth failure).
            // Retry with capped backoff rather than dropping the zone, so a
            // genuinely accessible zone never falls out of the enumeration on
            // a blip.
            Effect.retry({
              while: (e) => e._tag === "Unauthorized" || e._tag === "Forbidden",
              schedule: transientAuthRetrySchedule,
            }),
            Effect.map((observed) =>
              toAttributes(zoneId, observed, observed.value),
            ),
            // Zone deleted out-of-band or plan-gated: skip it.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
            Effect.catchTag("SettingUnavailableForPlan", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is RegionalTieredCacheAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as RegionalTieredCacheProps;
      const n = news as RegionalTieredCacheProps;
      // zoneId is Input<string>; compare only once both sides are concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof n.zoneId === "string" &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* cache.getRegionalTieredCache({ zoneId }).pipe(
        // Zone deleted out-of-band — the setting is gone with it.
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      // The setting is a singleton that always exists with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts
      // freely (never `Unowned`). The observed value at adoption time
      // becomes the `initialValue` restored on destroy.
      const initialValue =
        output !== undefined ? output.initialValue : observed.value;
      return toAttributes(zoneId, observed, initialValue);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the setting always exists (on entitled zones); read
      //    its live value. Plan-gated zones fail here with the typed
      //    `SettingUnavailableForPlan` error.
      const observed = yield* cache.getRegionalTieredCache({ zoneId });

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is
      //    the zone's original.
      const initialValue =
        output !== undefined ? output.initialValue : observed.value;

      // 3. Sync — patch only when the observed value differs.
      const desired = desiredValue(news);
      if (observed.value === desired) {
        return toAttributes(zoneId, observed, initialValue);
      }
      const patched = yield* cache.patchRegionalTieredCache({
        zoneId,
        value: desired,
      });
      return toAttributes(zoneId, patched, initialValue);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialValue } = output;
      // Observe — if the zone itself is gone (or the plan was downgraded
      // so the setting no longer exists for the zone), nothing to restore.
      const observed = yield* cache.getRegionalTieredCache({ zoneId }).pipe(
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
        Effect.catchTag("SettingUnavailableForPlan", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (observed.value === initialValue) return;
      yield* cache
        .patchRegionalTieredCache({ zoneId, value: initialValue })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

const toAttributes = (
  zoneId: string,
  setting:
    | cache.GetRegionalTieredCacheResponse
    | cache.PatchRegionalTieredCacheResponse,
  initialValue: string,
): RegionalTieredCacheAttributes => ({
  zoneId,
  value: setting.value,
  editable: setting.editable,
  modifiedOn: setting.modifiedOn ?? undefined,
  initialValue,
});
