import * as argo from "@distilled.cloud/cloudflare/argo";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Argo.TieredCaching" as const;
type TypeId = typeof TypeId;

export type TieredCachingProps = {
  /**
   * Zone the Tiered Caching setting belongs to. Stable — changing the
   * zone triggers a replacement (the old zone's setting is restored to
   * the value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Tiered Caching is enabled on the zone. Mutable — patched in
   * place.
   *
   * @default true
   */
  enabled?: boolean;
};

export type TieredCachingAttributes = {
  /** Zone the Tiered Caching setting belongs to. */
  zoneId: string;
  /** Resolved current value of the setting (`"on"` or `"off"`). */
  value: "on" | "off";
  /**
   * Whether the setting can be modified on the zone's current plan.
   */
  editable: boolean;
  /** When the setting was last modified, if Cloudflare reports it. */
  modifiedOn: string | undefined;
  /**
   * The value the setting had before Alchemy first patched it. Restored
   * on destroy, so deleting the resource puts the zone back the way it
   * was found.
   */
  initialValue: "on" | "off";
};

export type TieredCaching = Resource<
  TypeId,
  TieredCachingProps,
  TieredCachingAttributes,
  never,
  Providers
>;

/**
 * Tiered Caching for a Cloudflare zone
 * (`/zones/{zone_id}/argo/tiered_caching`).
 *
 * Tiered Caching routes cache misses through upper-tier Cloudflare data
 * centers instead of every edge location contacting the origin directly,
 * reducing origin load and improving cache hit ratios. It is available on
 * all plans, free included.
 *
 * The setting is a singleton — it always exists on every zone with a
 * Cloudflare default, so this resource never creates or deletes anything
 * physical. Reconcile patches the setting when the observed value differs
 * from the desired one; destroy restores the value the setting had before
 * Alchemy first managed it (captured as `initialValue`).
 *
 * This is the generic Tiered Cache toggle (the dashboard "Tiered Cache"
 * switch). Smart Tiered Cache (the smart-topology variant managed under
 * `/cache/tiered_cache_smart_topology_enable`) requires Tiered Caching to
 * be enabled — deploy this resource first when combining the two.
 * @resource
 * @product Argo
 * @category Performance & Reliability
 * @section Enabling Tiered Caching
 * @example Enable Tiered Caching on a zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Argo.TieredCaching("TieredCaching", {
 *   zoneId: zone.zoneId,
 * });
 * ```
 *
 * @example Explicitly disable Tiered Caching
 * ```typescript
 * yield* Cloudflare.Argo.TieredCaching("TieredCaching", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cache/how-to/tiered-cache/
 */
export const TieredCaching = Resource<TieredCaching>(TypeId);

/**
 * Returns true if the given value is a TieredCaching resource.
 */
export const isTieredCaching = (value: unknown): value is TieredCaching =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const TieredCachingProvider = () =>
  Provider.succeed(TieredCaching, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialValue"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting (every zone has one,
      // tiered caching is available on all plans).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          argo.getTieredCaching({ zoneId }).pipe(
            Effect.map((observed) =>
              toAttributes(zoneId, observed, toValue(observed.value)),
            ),
            // Zone deleted out-of-band between enumeration and read —
            // the setting is gone with it; skip it. A concurrently-purged
            // zone surfaces as `ZoneNotFound` (404 "Invalid or missing
            // zone") rather than the 7003 object-identifier code.
            Effect.catchTag(["InvalidObjectIdentifier", "ZoneNotFound"], () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is TieredCachingAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as TieredCachingProps;
      const n = news as TieredCachingProps;
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
      const observed = yield* argo.getTieredCaching({ zoneId }).pipe(
        // Zone deleted out-of-band — the setting is gone with it.
        Effect.catchTag("InvalidObjectIdentifier", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return undefined;
      // The setting is a singleton that always exists with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts freely
      // (never `Unowned`). The observed value at adoption time becomes the
      // `initialValue` restored on destroy.
      const initialValue =
        output !== undefined ? output.initialValue : toValue(observed.value);
      return toAttributes(zoneId, observed, initialValue);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desired: "on" | "off" = (news.enabled ?? true) ? "on" : "off";

      // 1. Observe — the setting always exists; read its live value.
      const observed = yield* argo.getTieredCaching({ zoneId });

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is
      //    the zone's original.
      const initialValue =
        output !== undefined ? output.initialValue : toValue(observed.value);

      // 3. Sync — patch only when the observed value differs.
      if (toValue(observed.value) === desired) {
        return toAttributes(zoneId, observed, initialValue);
      }
      const patched = yield* argo.patchTieredCaching({
        zoneId,
        value: desired,
      });
      return toAttributes(zoneId, patched, initialValue);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialValue } = output;
      // Observe — if the zone itself is gone, so is the setting.
      const observed = yield* argo
        .getTieredCaching({ zoneId })
        .pipe(
          Effect.catchTag("InvalidObjectIdentifier", () =>
            Effect.succeed(undefined),
          ),
        );
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (toValue(observed.value) === initialValue) return;
      yield* argo
        .patchTieredCaching({ zoneId, value: initialValue })
        .pipe(Effect.catchTag("InvalidObjectIdentifier", () => Effect.void));
    }),
  });

/**
 * Narrow the distilled response's open `"on" | "off" | (string & {})`
 * value to the closed pair — Cloudflare only ever returns the two
 * literals for this setting.
 */
const toValue = (value: string): "on" | "off" =>
  value === "on" ? "on" : "off";

const toAttributes = (
  zoneId: string,
  setting: argo.GetTieredCachingResponse | argo.PatchTieredCachingResponse,
  initialValue: "on" | "off",
): TieredCachingAttributes => ({
  zoneId,
  value: toValue(setting.value),
  editable: setting.editable,
  modifiedOn: setting.modifiedOn ?? undefined,
  initialValue,
});
