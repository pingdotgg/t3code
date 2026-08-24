import * as cache from "@distilled.cloud/cloudflare/cache";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Cache.Reserve" as const;
type TypeId = typeof TypeId;

export interface ReserveProps {
  /**
   * Zone whose Cache Reserve setting is managed. Stable — changing the
   * zone triggers a replacement (the old zone's setting is restored to
   * the value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Cache Reserve is enabled on the zone (`value: "on"`) or
   * disabled (`value: "off"`). Mutable — patched in place.
   * @default true
   */
  enabled?: boolean;
  /**
   * When true, destroying the resource also clears any data already
   * stored in Cache Reserve (after restoring the setting), waiting for
   * the asynchronous clear operation to complete. Disabling Cache
   * Reserve does NOT purge stored data by itself — storage continues to
   * bill until it expires or is cleared.
   * @default false
   */
  clearOnDelete?: boolean;
}

export interface ReserveAttributes {
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

export type Reserve = Resource<
  TypeId,
  ReserveProps,
  ReserveAttributes,
  never,
  Providers
>;

/**
 * The Cache Reserve setting of a Cloudflare zone
 * (`/zones/{zone_id}/cache/cache_reserve`).
 *
 * Cache Reserve is a large, persistent data store backed by R2 that serves
 * as the ultimate upper-tier cache, dramatically reducing origin egress for
 * cacheable content. The setting is a zone **singleton** — it always exists
 * on entitled zones (default `off`), so this resource never creates or
 * deletes anything physical. Reconcile patches the setting when the
 * observed value differs from the desired one; destroy restores the value
 * the setting had before Alchemy first managed it (captured as
 * `initialValue`).
 *
 * **Entitlement-gated**: Cache Reserve is a usage-billed add-on that must
 * be purchased/enabled on the account. On zones without the subscription
 * both reads and writes fail with the typed `SettingUnavailableForPlan`
 * error ("this zone setting is not available for your plan type").
 *
 * Disabling Cache Reserve does not purge data already in reserve — set
 * `clearOnDelete: true` to run the asynchronous Cache Reserve Clear
 * operation on destroy (the provider polls until the clear completes).
 *
 * Only one `Reserve` resource per zone makes sense — two instances
 * managing the same zone would fight over the singleton.
 * @resource
 * @product Cache
 * @category Performance & Reliability
 * @section Managing Cache Reserve
 * @example Enable Cache Reserve on a zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Cache.Reserve("Reserve", {
 *   zoneId: zone.zoneId,
 * });
 * ```
 *
 * @example Clear stored data when the resource is destroyed
 * ```typescript
 * yield* Cloudflare.Cache.Reserve("Reserve", {
 *   zoneId: zone.zoneId,
 *   clearOnDelete: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/
 */
export const Reserve = Resource<Reserve>(TypeId, {
  aliases: ["Cloudflare.Cache.CacheReserve"],
});

/**
 * Returns true if the given value is a Reserve resource.
 */
export const isReserve = (value: unknown): value is Reserve =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

const desiredValue = (props: ReserveProps): "on" | "off" =>
  (props.enabled ?? true) ? "on" : "off";

export const ReserveProvider = () =>
  Provider.succeed(Reserve, {
    stables: ["zoneId", "initialValue"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting. Cache Reserve is an
      // entitlement-gated add-on, so non-subscribed zones reject the
      // route (`SettingUnavailableForPlan`); skip those.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          cache.getCacheReserve({ zoneId }).pipe(
            Effect.map((observed) =>
              toAttributes(zoneId, observed, observed.value),
            ),
            // Plan-gated zones (no Cache Reserve subscription) and
            // partial/deleted zones reject the route; skip them.
            Effect.catchTag("SettingUnavailableForPlan", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is ReserveAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as ReserveProps;
      const n = news as ReserveProps;
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
      const observed = yield* cache.getCacheReserve({ zoneId }).pipe(
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
      //    its live value. Entitlement-gated zones fail here with the
      //    typed `SettingUnavailableForPlan` error.
      const observed = yield* cache.getCacheReserve({ zoneId });

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
      const patched = yield* cache.patchCacheReserve({
        zoneId,
        value: desired,
      });
      return toAttributes(zoneId, patched, initialValue);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      const { zoneId, initialValue } = output;
      // Observe — if the zone itself is gone (or the entitlement was
      // dropped so the setting no longer exists), nothing to restore.
      const observed = yield* cache.getCacheReserve({ zoneId }).pipe(
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
        Effect.catchTag("SettingUnavailableForPlan", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (observed.value !== initialValue) {
        yield* cache
          .patchCacheReserve({ zoneId, value: initialValue })
          .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
      }
      // Optionally clear data already stored in reserve — an async
      // operation that we kick off and poll to completion (bounded).
      if (olds?.clearOnDelete === true) {
        yield* cache.clearCacheReserve({ zoneId, body: {} });
        yield* cache.statusCacheReserve({ zoneId }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status) => status.state === "Completed",
            times: 60,
          }),
        );
      }
    }),
  });

const toAttributes = (
  zoneId: string,
  setting: cache.GetCacheReserveResponse | cache.PatchCacheReserveResponse,
  initialValue: string,
): ReserveAttributes => ({
  zoneId,
  value: setting.value,
  editable: setting.editable,
  modifiedOn: setting.modifiedOn ?? undefined,
  initialValue,
});
