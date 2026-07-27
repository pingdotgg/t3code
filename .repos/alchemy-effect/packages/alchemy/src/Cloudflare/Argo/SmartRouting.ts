import * as argo from "@distilled.cloud/cloudflare/argo";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Argo.SmartRouting" as const;
type TypeId = typeof TypeId;

export type SmartRoutingProps = {
  /**
   * Zone the Argo Smart Routing setting belongs to. Stable — changing the
   * zone triggers a replacement (the old zone's setting is restored to
   * the value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Argo Smart Routing is enabled on the zone. Mutable — patched
   * in place.
   *
   * @default true
   */
  enabled?: boolean;
};

export type SmartRoutingAttributes = {
  /** Zone the Argo Smart Routing setting belongs to. */
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

export type SmartRouting = Resource<
  TypeId,
  SmartRoutingProps,
  SmartRoutingAttributes,
  never,
  Providers
>;

/**
 * Argo Smart Routing for a Cloudflare zone
 * (`/zones/{zone_id}/argo/smart_routing`).
 *
 * Argo Smart Routing routes traffic across Cloudflare's network over the
 * least-congested, most-reliable paths instead of standard BGP routes,
 * reducing time to first byte for origin-bound requests.
 *
 * The setting is a singleton — it always exists on every zone with a
 * Cloudflare default, so this resource never creates or deletes anything
 * physical. Reconcile patches the setting when the observed value differs
 * from the desired one; destroy restores the value the setting had before
 * Alchemy first managed it (captured as `initialValue`).
 *
 * Argo Smart Routing is a paid, usage-billed add-on. On a zone without
 * the Argo subscription every read or patch of this setting fails with
 * the typed `NotAuthorized` error (Cloudflare code 1015) — purchase the
 * add-on on the zone before managing this resource.
 * @resource
 * @product Argo
 * @category Performance & Reliability
 * @section Enabling Smart Routing
 * @example Enable Argo Smart Routing on a zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Argo.SmartRouting("SmartRouting", {
 *   zoneId: zone.zoneId,
 * });
 * ```
 *
 * @example Explicitly disable Argo Smart Routing
 * ```typescript
 * yield* Cloudflare.Argo.SmartRouting("SmartRouting", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/argo-smart-routing/
 */
export const SmartRouting = Resource<SmartRouting>(TypeId);

/**
 * Returns true if the given value is a SmartRouting resource.
 */
export const isSmartRouting = (value: unknown): value is SmartRouting =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SmartRoutingProvider = () =>
  Provider.succeed(SmartRouting, {
    stables: ["zoneId", "initialValue"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          argo.getSmartRouting({ zoneId }).pipe(
            Effect.map((observed) =>
              toAttributes(zoneId, observed, toValue(observed.value)),
            ),
            // Argo Smart Routing is a paid add-on — zones without the
            // subscription reject every read with the typed entitlement
            // tag (code 1015); skip them. Zones deleted out-of-band
            // surface InvalidObjectIdentifier.
            Effect.catchTag("NotAuthorized", () => Effect.succeed(undefined)),
            Effect.catchTag("InvalidObjectIdentifier", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is SmartRoutingAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as SmartRoutingProps;
      const n = news as SmartRoutingProps;
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
      const observed = yield* argo.getSmartRouting({ zoneId }).pipe(
        // Zone deleted out-of-band — the setting is gone with it.
        Effect.catchTag("InvalidObjectIdentifier", () =>
          Effect.succeed(undefined),
        ),
        // Argo subscription removed out-of-band — the setting is no
        // longer visible or manageable on the zone.
        Effect.catchTag("NotAuthorized", () => Effect.succeed(undefined)),
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

      // 1. Observe — the setting always exists (NotAuthorized propagates
      //    as a typed, clear "Argo subscription required" failure).
      const observed = yield* argo.getSmartRouting({ zoneId });

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
      const patched = yield* argo.patchSmartRouting({
        zoneId,
        value: desired,
      });
      return toAttributes(zoneId, patched, initialValue);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialValue } = output;
      // Observe — if the zone is gone, or the Argo subscription was
      // removed out-of-band, the setting is no longer ours to restore.
      const observed = yield* argo.getSmartRouting({ zoneId }).pipe(
        Effect.catchTag("InvalidObjectIdentifier", () =>
          Effect.succeed(undefined),
        ),
        Effect.catchTag("NotAuthorized", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (toValue(observed.value) === initialValue) return;
      yield* argo.patchSmartRouting({ zoneId, value: initialValue }).pipe(
        Effect.catchTag("InvalidObjectIdentifier", () => Effect.void),
        Effect.catchTag("NotAuthorized", () => Effect.void),
      );
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
  setting: argo.GetSmartRoutingResponse | argo.PatchSmartRoutingResponse,
  initialValue: "on" | "off",
): SmartRoutingAttributes => ({
  zoneId,
  value: toValue(setting.value),
  editable: setting.editable,
  modifiedOn: setting.modifiedOn ?? undefined,
  initialValue,
});
