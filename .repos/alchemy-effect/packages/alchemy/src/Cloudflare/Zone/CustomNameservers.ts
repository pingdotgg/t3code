import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Zone.CustomNameservers" as const;
type TypeId = typeof TypeId;

export type CustomNameserversProps = {
  /**
   * Zone whose account-level custom nameserver usage is managed. Stable —
   * changing the zone triggers a replacement (the old zone's configuration
   * is restored to the value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether the zone uses account-level custom nameservers (ACNS) instead
   * of the Cloudflare-assigned nameservers.
   *
   * Enabling requires an account-level custom nameserver set to already be
   * configured (Business/Enterprise) — otherwise Cloudflare rejects the
   * update with the typed `CustomNameserverSetNotFound` error.
   *
   * Mutable — applied in place.
   */
  enabled: boolean;
  /**
   * The number of the account custom nameserver set to assign to the zone.
   * Only meaningful when `enabled` is `true`.
   *
   * Mutable — applied in place.
   *
   * @default 1 (Cloudflare's default nameserver set)
   */
  nsSet?: number;
};

export type CustomNameserversAttributes = {
  /** Zone whose custom nameserver usage is managed. */
  zoneId: string;
  /** Whether the zone currently uses account-level custom nameservers. */
  enabled: boolean;
  /** The nameserver set currently assigned to the zone, if reported. */
  nsSet: number | undefined;
  /**
   * Whether ACNS was enabled before Alchemy first touched the zone.
   * Restored on destroy, so deleting the resource puts the zone back the
   * way it was found.
   */
  initialEnabled: boolean;
  /** The nameserver set assigned before Alchemy first touched the zone. */
  initialNsSet: number | undefined;
};

export type CustomNameservers = Resource<
  TypeId,
  CustomNameserversProps,
  CustomNameserversAttributes,
  never,
  Providers
>;

/**
 * Controls whether a Cloudflare zone uses **account-level custom
 * nameservers** (ACNS, `/zones/{zone_id}/custom_ns`).
 *
 * This configuration is a zone singleton — it always exists on every zone
 * (disabled by default), so the resource never creates or deletes anything
 * physical. Reconcile applies the desired `enabled`/`nsSet` when the
 * observed configuration differs; destroy restores the configuration the
 * zone had before Alchemy first managed it.
 *
 * Enabling requires an account custom nameserver set to be configured first
 * (Business/Enterprise feature). Without one, Cloudflare rejects the update
 * with the typed `CustomNameserverSetNotFound` error.
 * @resource
 * @product Zones
 * @category Domains & DNS
 * @section Enabling account custom nameservers
 * @example Use the account's default nameserver set
 * ```typescript
 * yield* Cloudflare.Zone.CustomNameservers("CustomNs", {
 *   zoneId: zone.zoneId,
 *   enabled: true,
 * });
 * ```
 *
 * @example Pin a specific nameserver set
 * ```typescript
 * yield* Cloudflare.Zone.CustomNameservers("CustomNs", {
 *   zoneId: zone.zoneId,
 *   enabled: true,
 *   nsSet: 2,
 * });
 * ```
 *
 * @section Disabling
 * @example Explicitly pin the zone to Cloudflare-assigned nameservers
 * ```typescript
 * yield* Cloudflare.Zone.CustomNameservers("CustomNs", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api/resources/zones/subresources/custom_nameservers/
 */
export const CustomNameservers = Resource<CustomNameservers>(TypeId);

/**
 * Returns true if the given value is a CustomNameservers resource.
 */
export const isCustomNameservers = (
  value: unknown,
): value is CustomNameservers =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CustomNameserversProvider = () =>
  Provider.succeed(CustomNameservers, {
    stables: ["zoneId", "initialEnabled", "initialNsSet"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its custom-nameserver config.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          zones.getCustomNameserver({ zoneId }).pipe(
            Effect.map((observed) => {
              // Only zones actively using account custom nameservers are
              // worth enumerating — a disabled (default) toggle has
              // nothing to restore on destroy.
              if (!(observed.enabled ?? false)) return undefined;
              return toAttributes(
                zoneId,
                observed,
                observed.enabled ?? false,
                observed.nsSet ?? undefined,
              );
            }),
            // ACNS is a Business/Enterprise feature — plan-gated zones
            // reject with `Forbidden`; zones deleted out-of-band 404 with
            // `InvalidZoneIdentifier`. Skip both.
            Effect.catchTag(["InvalidZoneIdentifier", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is CustomNameserversAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      // zoneId is the resource's identity; compare only once both sides
      // are concrete (resolved) values.
      if (!isResolved(news)) return undefined;
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
      if (!zoneId) return undefined;
      const observed = yield* zones.getCustomNameserver({ zoneId }).pipe(
        // Zone deleted out-of-band — the configuration is gone with it.
        Effect.catchTag("InvalidZoneIdentifier", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return undefined;
      // The custom-NS toggle is a singleton that always exists (disabled
      // by default) — there is nothing to "own", so a cold read adopts
      // freely (never `Unowned`). The observed state at adoption time
      // becomes the baseline restored on destroy.
      const initialEnabled =
        output !== undefined
          ? output.initialEnabled
          : (observed.enabled ?? false);
      const initialNsSet =
        output !== undefined
          ? output.initialNsSet
          : (observed.nsSet ?? undefined);
      return toAttributes(zoneId, observed, initialEnabled, initialNsSet);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the configuration always exists; read its live state.
      const observed = yield* zones.getCustomNameserver({ zoneId });

      // 2. Capture — the pre-management state, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed state is
      //    the zone's original.
      const initialEnabled =
        output !== undefined
          ? output.initialEnabled
          : (observed.enabled ?? false);
      const initialNsSet =
        output !== undefined
          ? output.initialNsSet
          : (observed.nsSet ?? undefined);

      // 3. Sync — apply only when the observed state differs.
      const observedEnabled = observed.enabled ?? false;
      const observedNsSet = observed.nsSet ?? undefined;
      const inSync =
        observedEnabled === news.enabled &&
        (news.nsSet === undefined || observedNsSet === news.nsSet);
      if (inSync) {
        return toAttributes(zoneId, observed, initialEnabled, initialNsSet);
      }
      yield* zones.putCustomNameserver({
        zoneId,
        enabled: news.enabled,
        ...(news.nsSet !== undefined ? { nsSet: news.nsSet } : {}),
      });
      // The PUT response does not reliably echo the resulting state —
      // re-read so the attributes reflect the observed cloud state.
      const final = yield* zones.getCustomNameserver({ zoneId });
      return toAttributes(zoneId, final, initialEnabled, initialNsSet);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialEnabled, initialNsSet } = output;
      // Observe — if the zone itself is gone, so is the configuration.
      const observed = yield* zones
        .getCustomNameserver({ zoneId })
        .pipe(
          Effect.catchTag("InvalidZoneIdentifier", () =>
            Effect.succeed(undefined),
          ),
        );
      if (observed === undefined) return;
      // Restore the pre-management state; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      const observedEnabled = observed.enabled ?? false;
      const observedNsSet = observed.nsSet ?? undefined;
      if (
        observedEnabled === initialEnabled &&
        (initialNsSet === undefined || observedNsSet === initialNsSet)
      ) {
        return;
      }
      yield* zones
        .putCustomNameserver({
          zoneId,
          enabled: initialEnabled,
          ...(initialNsSet !== undefined ? { nsSet: initialNsSet } : {}),
        })
        .pipe(
          // Zone deleted out-of-band, or the account nameserver set the
          // zone originally referenced no longer exists — nothing left to
          // restore.
          Effect.catchTag(
            ["InvalidZoneIdentifier", "CustomNameserverSetNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

const toAttributes = (
  zoneId: string,
  observed: zones.GetCustomNameserverResponse,
  initialEnabled: boolean,
  initialNsSet: number | undefined,
): CustomNameserversAttributes => ({
  zoneId,
  enabled: observed.enabled ?? false,
  nsSet: observed.nsSet ?? undefined,
  initialEnabled,
  initialNsSet,
});
