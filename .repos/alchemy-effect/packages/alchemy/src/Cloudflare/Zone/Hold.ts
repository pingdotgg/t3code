import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "./lookup.ts";

const TypeId = "Cloudflare.Zone.Hold" as const;
type TypeId = typeof TypeId;

export type HoldProps = {
  /**
   * Zone to place the hold on. Stable — changing the zone triggers a
   * replacement (the hold is removed from the old zone and placed on the
   * new one).
   */
  zoneId: string;
  /**
   * Extend the hold to block any subdomain of the zone, as well as
   * SSL4SaaS Custom Hostnames. For example, a hold on `example.com` with
   * `includeSubdomains: true` also blocks `staging.example.com` from
   * being added to another account.
   *
   * Mutable — patched in place.
   * @default false
   */
  includeSubdomains?: boolean;
};

export type HoldAttributes = {
  /** Zone the hold is placed on. */
  zoneId: string;
  /** Whether the hold is currently active. */
  hold: boolean;
  /**
   * If present and future-dated, the hold is temporarily disabled and
   * will automatically re-enable at this RFC3339 timestamp.
   */
  holdAfter: string | undefined;
  /** Whether the hold also blocks subdomains and SSL4SaaS Custom Hostnames. */
  includeSubdomains: boolean;
};

export type Hold = Resource<
  TypeId,
  HoldProps,
  HoldAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare zone hold (`/zones/{zone_id}/hold`) — prevents the zone's
 * hostname (and optionally its subdomains) from being added to another
 * Cloudflare account while the hold is active.
 *
 * Zone holds are only available on **Enterprise** zones. On other plans
 * every create/patch fails with Cloudflare code 1005, surfaced as the typed
 * `ZoneHoldsRequireEnterprise` error.
 *
 * Destroying the resource removes the hold. The delete is idempotent —
 * removing a hold that is already gone (or whose zone was deleted
 * out-of-band) succeeds.
 * @resource
 * @product Zones
 * @category Domains & DNS
 * @section Holding a zone
 * @example Place a hold on a zone
 * ```typescript
 * const hold = yield* Cloudflare.Zone.Hold("MyHold", {
 *   zoneId: zone.zoneId,
 * });
 * ```
 *
 * @example Hold the zone and all of its subdomains
 * ```typescript
 * yield* Cloudflare.Zone.Hold("MyHold", {
 *   zoneId: zone.zoneId,
 *   includeSubdomains: true,
 * });
 * ```
 *
 * @section Adopting an existing hold
 * @example Take over a hold that was placed outside Alchemy
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 * // A hold carries no ownership markers, so the engine refuses to take
 * // over a pre-existing hold unless you opt in with `adopt(true)`.
 * const hold = yield* Cloudflare.Zone.Hold("MyHold", {
 *   zoneId: zone.zoneId,
 * }).pipe(adopt(true));
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/account/account-security/zone-holds/
 */
export const Hold = Resource<Hold>(TypeId);

/**
 * Returns true if the given value is a Hold resource.
 */
export const isHold = (value: unknown): value is Hold =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

// Cloudflare can transiently fail to authenticate a valid token, surfacing as
// `Forbidden`. Retry with exponential backoff capped at 5s, bounded to ~8
// attempts so a persistently-unauthorized call still fails fast.
const forbiddenRetrySchedule = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("5 seconds"),
  ]),
  Schedule.recurs(8),
]);

export const HoldProvider = () =>
  Provider.succeed(Hold, {
    stables: ["zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // A hold is a per-zone singleton — `getHold` always returns a record
      // for every zone (default `hold: false`), and there is no account-wide
      // enumeration API. Enumerate every zone and read its hold state.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          zones.getHold({ zoneId }).pipe(
            // Cloudflare intermittently rejects a *valid* token with
            // `Forbidden` (a transient edge auth failure). It is retryable —
            // back off and try again rather than dropping the zone, so a
            // genuinely accessible zone (e.g. the standing test zone) never
            // silently falls out of the enumeration on a blip.
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: forbiddenRetrySchedule,
            }),
            Effect.map((observed) => toAttributes(zoneId, observed)),
            // Zone deleted out-of-band mid-enumeration — drop it.
            Effect.catchTag("InvalidZoneIdentifier", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is HoldAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as HoldProps;
      const n = news as HoldProps;
      // zoneId is the hold's identity (one hold per zone). It is
      // Input<string>; compare only once both sides are concrete.
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
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (!zoneId) return undefined;
      const observed = yield* zones.getHold({ zoneId }).pipe(
        // Zone deleted out-of-band — the hold is gone with it.
        Effect.catchTag("InvalidZoneIdentifier", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined || observed.hold !== true) return undefined;
      const attrs = toAttributes(zoneId, observed);
      // Cold read: a hold exists but we have no state for it. Holds carry
      // no ownership markers, so gate the takeover behind `--adopt`.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desiredIncludeSubdomains = news.includeSubdomains ?? false;

      // 1. Observe — is the zone currently held?
      const observed = yield* zones.getHold({ zoneId });

      // 2. Ensure — place the hold if the zone is not held.
      if (observed.hold !== true) {
        const created = yield* zones.createHold({
          zoneId,
          includeSubdomains: desiredIncludeSubdomains,
        });
        return toAttributes(zoneId, created);
      }

      // 3. Sync — patch includeSubdomains when the observed value differs.
      if (
        normalizeIncludeSubdomains(observed.includeSubdomains) !==
        desiredIncludeSubdomains
      ) {
        const patched = yield* zones
          .patchHold({
            zoneId,
            includeSubdomains: desiredIncludeSubdomains,
          })
          .pipe(
            // The hold vanished between observe and patch (out-of-band
            // removal race) — place it fresh with the desired settings.
            Effect.catchTag("ZoneHoldNotFound", () =>
              zones.createHold({
                zoneId,
                includeSubdomains: desiredIncludeSubdomains,
              }),
            ),
          );
        return toAttributes(zoneId, patched);
      }

      return toAttributes(zoneId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Removing a hold is naturally idempotent — Cloudflare returns the
      // (un-held) hold state even when no hold exists. Tolerate the zone
      // itself having been deleted out-of-band.
      yield* zones
        .deleteHold({ zoneId: output.zoneId })
        .pipe(Effect.catchTag("InvalidZoneIdentifier", () => Effect.void));
    }),
  });

/**
 * Normalize Cloudflare's `include_subdomains` response value. The live API
 * returns a boolean, while Cloudflare's published schema declares a string
 * (`"true"`/`"false"`) — accept both.
 */
const normalizeIncludeSubdomains = (value: unknown): boolean =>
  value === true || value === "true";

const toAttributes = (
  zoneId: string,
  hold:
    | zones.GetHoldResponse
    | zones.CreateHoldResponse
    | zones.PatchHoldResponse,
): HoldAttributes => ({
  zoneId,
  hold: hold.hold === true,
  holdAfter: hold.holdAfter ?? undefined,
  includeSubdomains: normalizeIncludeSubdomains(hold.includeSubdomains),
});
