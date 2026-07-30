import * as urlNormalization from "@distilled.cloud/cloudflare/url-normalization";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.UrlNormalization.UrlNormalization" as const;
type TypeId = typeof TypeId;

/**
 * Which URLs Cloudflare normalizes.
 *
 * - `"incoming"` — normalize the URLs used for rule matching only
 *   (Cloudflare's zone default).
 * - `"both"` — additionally normalize the URLs forwarded to the origin.
 * - `"none"` — disable URL normalization entirely.
 */
export type UrlNormalizationScope = "incoming" | "both" | "none";

/**
 * Which normalization algorithm Cloudflare applies.
 *
 * - `"cloudflare"` — RFC 3986 normalization plus Cloudflare's extra
 *   normalizations (e.g. collapsing `//` sequences). The zone default.
 * - `"rfc3986"` — strict RFC 3986 normalization only.
 */
export type Type = "cloudflare" | "rfc3986";

export interface Props {
  /**
   * Zone whose URL normalization is managed. Stable — changing the zone
   * triggers a replacement (the old zone's URL normalization is reset to
   * Cloudflare defaults as the old instance deletes).
   */
  zoneId: string;
  /**
   * The scope of the URL normalization: `"incoming"` normalizes URLs used
   * for rule matching only, `"both"` also normalizes URLs sent to the
   * origin, `"none"` disables normalization.
   *
   * Mutable — updated in place.
   *
   * @default "incoming"
   */
  scope?: UrlNormalizationScope;
  /**
   * The type of URL normalization performed by Cloudflare:
   * `"cloudflare"` is RFC 3986 plus extra normalizations (e.g. `//`
   * collapsing), `"rfc3986"` is strict RFC 3986 only.
   *
   * Mutable — updated in place.
   *
   * @default "cloudflare"
   */
  type?: Type;
}

export interface Attributes {
  /** Zone whose URL normalization is managed. */
  zoneId: string;
  /** Observed scope of the URL normalization. */
  scope: string;
  /** Observed type of URL normalization performed by Cloudflare. */
  type: string;
}

export type UrlNormalization = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * The URL normalization configuration of a Cloudflare zone
 * (`/zones/{zone_id}/url_normalization`) — a zone-scoped **singleton**
 * controlling how Cloudflare normalizes incoming URLs before rule matching
 * and before forwarding to the origin.
 *
 * The setting always exists on every zone (with Cloudflare defaults
 * `scope: "incoming"`, `type: "cloudflare"`), so reconcile adopts the
 * singleton and PUTs the desired `{ scope, type }` only when the observed
 * configuration differs. Destroy issues the API's true reset operation
 * (DELETE), returning the zone to Cloudflare defaults.
 * @resource
 * @product URL Normalization
 * @category Rules & Configuration
 * @section Managing URL normalization
 * @example Normalize URLs sent to the origin too
 * ```typescript
 * yield* Cloudflare.UrlNormalization.UrlNormalization("UrlNormalization", {
 *   zoneId: zone.zoneId,
 *   scope: "both",
 * });
 * ```
 *
 * @example Strict RFC 3986 normalization
 * ```typescript
 * yield* Cloudflare.UrlNormalization.UrlNormalization("UrlNormalization", {
 *   zoneId: zone.zoneId,
 *   scope: "incoming",
 *   type: "rfc3986",
 * });
 * ```
 *
 * @example Disable URL normalization
 * ```typescript
 * yield* Cloudflare.UrlNormalization.UrlNormalization("UrlNormalization", {
 *   zoneId: zone.zoneId,
 *   scope: "none",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/rules/normalization/
 */
export const UrlNormalization = Resource<UrlNormalization>(TypeId, {
  aliases: ["Cloudflare.UrlNormalization"],
});

/**
 * Returns true if the given value is a UrlNormalization resource.
 */
export const isUrlNormalization = (value: unknown): value is UrlNormalization =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/** Cloudflare's zone default scope. */
const DEFAULT_SCOPE: UrlNormalizationScope = "incoming";
/** Cloudflare's zone default normalization type. */
const DEFAULT_TYPE: Type = "cloudflare";

export const UrlNormalizationProvider = () =>
  Provider.succeed(UrlNormalization, {
    nuke: { singleton: true },
    stables: ["zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its URL normalization (every zone
      // has one).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          urlNormalization.getUrlNormalization({ zoneId }).pipe(
            // Cloudflare intermittently rejects a *valid* token with
            // `Forbidden` (a transient edge auth failure). Retry with capped
            // backoff rather than dropping the zone, so a genuinely accessible
            // zone never falls out of the enumeration on a blip.
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
            Effect.map((observed) => toAttributes(zoneId, observed)),
            // Plan-gated or partial zones reject the route; skip them.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is Attributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as Props;
      const n = news as Props;
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
      // The setting is a singleton that always exists with Cloudflare
      // defaults — there is nothing to "own", so a cold read adopts freely
      // (never `Unowned`). A dead zone reads as gone.
      const observed = yield* urlNormalization
        .getUrlNormalization({ zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));
      if (observed === undefined) return undefined;
      return toAttributes(zoneId, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desiredScope = news.scope ?? DEFAULT_SCOPE;
      const desiredType = news.type ?? DEFAULT_TYPE;

      // 1. Observe — the singleton always exists on a live zone.
      const observed = yield* urlNormalization.getUrlNormalization({ zoneId });

      // 2. Sync — PUT is a full replace of { scope, type }; skip the API
      //    entirely when the observed configuration already matches.
      if (observed.scope === desiredScope && observed.type === desiredType) {
        return toAttributes(zoneId, observed);
      }
      const updated = yield* urlNormalization.putUrlNormalization({
        zoneId,
        scope: desiredScope,
        type: desiredType,
      });
      return toAttributes(zoneId, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      // True reset operation — returns the zone to Cloudflare defaults.
      // Idempotent: resetting an already-default zone succeeds, and a dead
      // zone is treated as already reset.
      yield* urlNormalization
        .deleteUrlNormalization({ zoneId: output.zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

const toAttributes = (
  zoneId: string,
  observed: urlNormalization.GetUrlNormalizationResponse,
): Attributes => ({
  zoneId,
  scope: observed.scope,
  type: observed.type,
});
