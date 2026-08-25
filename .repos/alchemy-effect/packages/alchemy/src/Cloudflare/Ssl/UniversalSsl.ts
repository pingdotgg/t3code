import * as ssl from "@distilled.cloud/cloudflare/ssl";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Ssl.UniversalSsl" as const;
type TypeId = typeof TypeId;

export type UniversalSslProps = {
  /**
   * Zone whose Universal SSL setting is managed. Stable — changing the
   * zone triggers a replacement (the old zone's setting is restored to
   * the value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Universal SSL certificates are issued for the zone.
   *
   * Disabling removes any currently active Universal SSL certificates
   * for the zone from the edge and prevents future Universal SSL
   * certificates from being ordered — visitors will see TLS errors
   * unless the zone has advanced/custom certificates covering its
   * hostnames.
   *
   * Mutable — patched in place.
   */
  enabled: boolean;
};

export type UniversalSslAttributes = {
  /** Zone the setting belongs to. */
  zoneId: string;
  /** Whether Universal SSL is currently enabled for the zone. */
  enabled: boolean;
  /**
   * The value the setting had before Alchemy first patched it. Restored
   * on destroy, so deleting the resource puts the zone back the way it
   * was found.
   */
  initialEnabled: boolean;
};

export type UniversalSsl = Resource<
  TypeId,
  UniversalSslProps,
  UniversalSslAttributes,
  never,
  Providers
>;

/**
 * The Universal SSL setting of a Cloudflare zone
 * (`/zones/{zone_id}/ssl/universal/settings`).
 *
 * Universal SSL is a zone singleton — the setting always exists (Cloudflare
 * defaults it to enabled), so this resource never creates or deletes
 * anything physical. Reconcile patches the setting when the observed value
 * differs from the desired one; destroy restores the value the setting had
 * before Alchemy first managed it (captured as `initialEnabled`).
 *
 * **Warning:** disabling Universal SSL removes any active Universal SSL
 * certificates for the zone from the edge. Visitors will see TLS errors
 * unless advanced/custom certificates cover the zone's hostnames.
 * @resource
 * @product SSL/TLS
 * @category SSL/TLS & Certificates
 * @section Managing Universal SSL
 * @example Disable Universal SSL for a zone
 * ```typescript
 * yield* Cloudflare.Ssl.UniversalSsl("UniversalSsl", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @example Pin Universal SSL enabled
 * ```typescript
 * yield* Cloudflare.Ssl.UniversalSsl("UniversalSsl", {
 *   zoneId: zone.zoneId,
 *   enabled: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api/resources/ssl/subresources/universal/subresources/settings/
 */
export const UniversalSsl = Resource<UniversalSsl>(TypeId);

/**
 * Returns true if the given value is a UniversalSsl resource.
 */
export const isUniversalSsl = (value: unknown): value is UniversalSsl =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * The Universal SSL "edit setting" endpoint enforces its OWN per-zone,
 * per-operation rate limit ("Rate limit reached for the update operation.
 * Please try again in a minute") — much longer than the engine's blanket
 * retry budget (~40s). Ride it out patiently on the typed `TooManyRequests`
 * within a bounded number of attempts (~120s total) so a concurrent or
 * recent patch on the same zone's singleton doesn't fail the operation.
 */
const patchUniversal = (input: { zoneId: string; enabled: boolean }) =>
  ssl.patchUniversalSetting(input).pipe(
    Effect.retry({
      while: (e) => e._tag === "TooManyRequests",
      schedule: Schedule.spaced("20 seconds"),
      times: 6,
    }),
  );

export const UniversalSslProvider = () =>
  Provider.succeed(UniversalSsl, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialEnabled"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting (every zone has one).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          ssl.getUniversalSetting({ zoneId }).pipe(
            Effect.map((observed) => {
              const enabled = observedEnabled(observed);
              // Observed value is the pre-management value at adoption.
              return { zoneId, enabled, initialEnabled: enabled };
            }),
            // Plan-gated or partial zones reject the route; skip them.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is UniversalSslAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      // news is Input<Props> during plan — only compare once resolved.
      if (!isResolved(news)) return undefined;
      // zoneId is the resource's identity; it is Input<string>, so
      // compare only once both sides are concrete.
      const oldZoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof news.zoneId === "string" &&
        oldZoneId !== news.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* ssl.getUniversalSetting({ zoneId }).pipe(
        // Zone deleted out-of-band — the setting is gone with it.
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      const enabled = observedEnabled(observed);
      // Universal SSL is a singleton that always exists with a
      // Cloudflare default — there is nothing to "own", so a cold read
      // adopts freely (never `Unowned`). The observed value at adoption
      // time becomes the `initialEnabled` restored on destroy.
      const initialEnabled =
        output !== undefined ? output.initialEnabled : enabled;
      return { zoneId, enabled, initialEnabled };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the setting always exists; read its live value.
      const observed = yield* ssl.getUniversalSetting({ zoneId });
      const enabled = observedEnabled(observed);

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is
      //    the zone's original.
      const initialEnabled =
        output !== undefined ? output.initialEnabled : enabled;

      // 3. Sync — patch only when the observed value differs.
      if (enabled === news.enabled) {
        return { zoneId, enabled, initialEnabled };
      }
      const patched = yield* patchUniversal({
        zoneId,
        enabled: news.enabled,
      });
      return { zoneId, enabled: observedEnabled(patched), initialEnabled };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialEnabled } = output;
      // Observe — if the zone itself is gone, so is the setting.
      const observed = yield* ssl
        .getUniversalSetting({ zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (observedEnabled(observed) === initialEnabled) return;
      yield* patchUniversal({ zoneId, enabled: initialEnabled }).pipe(
        Effect.catchTag("InvalidRoute", () => Effect.void),
      );
    }),
  });

/**
 * Normalize the distilled response's `enabled?: boolean | null` to a
 * concrete boolean — Cloudflare's default for Universal SSL is enabled.
 */
const observedEnabled = (
  setting: ssl.GetUniversalSettingResponse | ssl.PatchUniversalSettingResponse,
): boolean => setting.enabled ?? true;
