import * as waitingRooms from "@distilled.cloud/cloudflare/waiting-rooms";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.WaitingRoom.Settings" as const;
type TypeId = typeof TypeId;

export type SettingsProps = {
  /**
   * Zone whose waiting room settings are managed. Stable — changing the
   * zone triggers a replacement (the old zone's settings are restored to
   * the value they had before Alchemy managed them).
   */
  zoneId: string;
  /**
   * Whether to allow verified search engine crawlers to bypass all waiting
   * rooms on this zone. Enabling the bypass requires the Waiting Room
   * Advanced subscription. Mutable.
   * @default false
   */
  searchEngineCrawlerBypass?: boolean;
};

export type SettingsAttributes = {
  /** Zone the settings belong to. */
  zoneId: string;
  /** Whether verified search engine crawlers bypass all waiting rooms. */
  searchEngineCrawlerBypass: boolean;
  /**
   * The value the setting had before Alchemy first managed it. Restored on
   * destroy, so deleting the resource puts the zone back the way it was
   * found.
   */
  initialSearchEngineCrawlerBypass: boolean;
};

export type Settings = Resource<
  TypeId,
  SettingsProps,
  SettingsAttributes,
  never,
  Providers
>;

/**
 * Zone-wide Cloudflare Waiting Room settings
 * (`/zones/{zone_id}/waiting_rooms/settings`).
 *
 * The settings object is a zone singleton — it always exists with
 * Cloudflare defaults, so this resource never creates or deletes anything
 * physical. Reconcile PUTs the settings when the observed value differs
 * from the desired one; destroy restores the value the zone had before
 * Alchemy first managed it.
 *
 * Writes are plan-gated: on zones without a Waiting Rooms entitlement
 * (Business/Enterprise) every PUT fails with the typed `ZoneNotEntitled`
 * error (Cloudflare code 1034). Reads work on every plan, and a no-op
 * reconcile (desired equals observed) skips the API call entirely.
 * @resource
 * @product Waiting Rooms
 * @category Performance & Reliability
 * @section Managing settings
 * @example Let search engine crawlers bypass waiting rooms
 * ```typescript
 * yield* Cloudflare.WaitingRoom.Settings("CrawlerBypass", {
 *   zoneId: zone.zoneId,
 *   searchEngineCrawlerBypass: true,
 * });
 * ```
 *
 * @example Pin the settings to their defaults
 * ```typescript
 * yield* Cloudflare.WaitingRoom.Settings("Defaults", {
 *   zoneId: zone.zoneId,
 *   searchEngineCrawlerBypass: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waiting-room/
 */
export const Settings = Resource<Settings>(TypeId);

/**
 * Returns true if the given value is a Settings resource.
 */
export const isSettings = (value: unknown): value is Settings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SettingsProvider = () =>
  Provider.succeed(Settings, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialSearchEngineCrawlerBypass"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its settings (every zone has one).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          waitingRooms.getSetting({ zoneId }).pipe(
            // A freshly-minted scoped token propagates eventually-
            // consistently across Cloudflare's edge — ride out transient
            // 403 blips before giving up on a zone. The backoff is CAPPED at
            // 5s and bounded to ~8 attempts (~40s): an uncapped
            // `Schedule.exponential` reaches a 64s single delay by the 8th
            // retry (~128s total) which, fanned across every zone, blows the
            // test timeout when a zone is persistently 403.
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: Schedule.max([
                Schedule.min([
                  Schedule.exponential("500 millis"),
                  Schedule.spaced("5 seconds"),
                ]),
                Schedule.recurs(8),
              ]),
            }),
            Effect.map((observed) =>
              toAttributes(
                zoneId,
                observed.searchEngineCrawlerBypass,
                observed.searchEngineCrawlerBypass,
              ),
            ),
            // Plan-gated or partial zones reject the route; a zone the token
            // still can't read (persistent 403) isn't ours to enumerate —
            // skip both rather than failing the whole listing.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is SettingsAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as SettingsProps;
      const n = news as SettingsProps;
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
      const observed = yield* waitingRooms.getSetting({ zoneId }).pipe(
        // Zone deleted out-of-band — the settings are gone with it.
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      // The settings singleton always exists with a Cloudflare default —
      // there is nothing to "own", so a cold read adopts freely. The
      // observed value at adoption time becomes the initial value restored
      // on destroy.
      const initial =
        output !== undefined
          ? output.initialSearchEngineCrawlerBypass
          : observed.searchEngineCrawlerBypass;
      return toAttributes(zoneId, observed.searchEngineCrawlerBypass, initial);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the settings singleton always exists.
      const observed = yield* waitingRooms.getSetting({ zoneId });

      // 2. Capture — the pre-management value, restored on destroy.
      const initial =
        output !== undefined
          ? output.initialSearchEngineCrawlerBypass
          : observed.searchEngineCrawlerBypass;

      // 3. Sync — PUT only when the observed value differs.
      const desired = news.searchEngineCrawlerBypass ?? false;
      if (observed.searchEngineCrawlerBypass === desired) {
        return toAttributes(
          zoneId,
          observed.searchEngineCrawlerBypass,
          initial,
        );
      }
      const updated = yield* waitingRooms.putSetting({
        zoneId,
        searchEngineCrawlerBypass: desired,
      });
      return toAttributes(zoneId, updated.searchEngineCrawlerBypass, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialSearchEngineCrawlerBypass } = output;
      // Observe — if the zone itself is gone, so are the settings.
      const observed = yield* waitingRooms
        .getSetting({ zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (
        observed.searchEngineCrawlerBypass === initialSearchEngineCrawlerBypass
      ) {
        return;
      }
      yield* waitingRooms
        .putSetting({
          zoneId,
          searchEngineCrawlerBypass: initialSearchEngineCrawlerBypass,
        })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

const toAttributes = (
  zoneId: string,
  searchEngineCrawlerBypass: boolean,
  initialSearchEngineCrawlerBypass: boolean,
): SettingsAttributes => ({
  zoneId,
  searchEngineCrawlerBypass,
  initialSearchEngineCrawlerBypass,
});
