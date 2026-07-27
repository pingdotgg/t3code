import * as googleTagGateway from "@distilled.cloud/cloudflare/google-tag-gateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type Reference } from "../Zone/index.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.GoogleTagGateway.GoogleTagGateway" as const;
type TypeId = typeof TypeId;

/**
 * The plain Google Tag Gateway configuration shape — the value PUT to and
 * read back from `/zones/{zone_id}/settings/google-tag-gateway/config`.
 */
export type Config = {
  /** Whether Google Tag Gateway is enabled for the zone. */
  enabled: boolean;
  /** Endpoint path used to proxy Google Tag Manager requests. */
  endpoint: string;
  /** Whether the original client IP address is hidden from Google. */
  hideOriginalIp: boolean;
  /** Google Tag Manager container or measurement ID. */
  measurementId: string;
  /** Whether the associated Google tag is set up on the zone automatically. */
  setUpTag: boolean | undefined;
};

export type Props = {
  /**
   * Zone whose Google Tag Gateway config should be managed. Accepts a zone
   * id, a zone name (`example.com`), or a `{ zoneId, name? }` object.
   *
   * Stable — the config belongs to the zone, so changing the zone triggers
   * a replacement (the old zone's config is restored to the value it had
   * before Alchemy managed it).
   */
  zone: Reference;
  /**
   * Enables or disables Google Tag Gateway for the zone.
   */
  enabled: boolean;
  /**
   * Endpoint path for proxying Google Tag Manager requests. Must be an
   * absolute path starting with `/`, with no nested paths and alphanumeric
   * characters only (e.g. `/metrics`).
   */
  endpoint: string;
  /**
   * Google Tag Manager container or measurement ID
   * (e.g. `GTM-XXXXXXX` or `G-XXXXXXXXXX`).
   */
  measurementId: string;
  /**
   * Hides the original client IP address from Google when enabled.
   */
  hideOriginalIp: boolean;
  /**
   * Set up the associated Google tag on the zone automatically when
   * enabled. When omitted, the zone's current value is retained
   * (Cloudflare's own default is `true`).
   *
   * @default retain the zone's current value
   */
  setUpTag?: boolean;
};

export type Attributes = Config & {
  /** Cloudflare zone id the config belongs to. */
  zoneId: string;
  /**
   * The configuration the zone had before Alchemy first managed it
   * (`undefined` when the zone had never configured Google Tag Gateway).
   * Restored on destroy, so deleting the resource puts the zone back the
   * way it was found.
   */
  initialConfig: Config | undefined;
};

export type GoogleTagGateway = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * Google Tag Gateway configuration for a Cloudflare zone
 * (`/zones/{zone_id}/settings/google-tag-gateway/config`).
 *
 * Google Tag Gateway serves Google Tag Manager / gtag.js first-party through
 * the zone — requests to the configured endpoint path are proxied to Google
 * by Cloudflare's edge. The config is a zone-level singleton: there is one
 * per zone and the PUT API is a full replace, so reconcile is a single
 * idempotent upsert. Destroy restores the configuration the zone had before
 * Alchemy first managed it (or disables the gateway when the zone had never
 * configured it).
 * @resource
 * @product Google Tag Gateway
 * @category Performance & Reliability
 * @section Managing the gateway
 * @example Enable Google Tag Gateway on a zone
 * ```typescript
 * const gateway = yield* Cloudflare.GoogleTagGateway.GoogleTagGateway("Analytics", {
 *   zone: "example.com",
 *   enabled: true,
 *   endpoint: "/metrics",
 *   measurementId: "G-XXXXXXXXXX",
 *   hideOriginalIp: true,
 * });
 * ```
 *
 * @example Proxy a Google Tag Manager container without auto-installing the tag
 * ```typescript
 * const gateway = yield* Cloudflare.GoogleTagGateway.GoogleTagGateway("Gtm", {
 *   zone: zone.zoneId,
 *   enabled: true,
 *   endpoint: "/collect",
 *   measurementId: "GTM-XXXXXXX",
 *   hideOriginalIp: false,
 *   setUpTag: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/google-tag-gateway/
 */
export const GoogleTagGateway = Resource<GoogleTagGateway>(TypeId, {
  aliases: ["Cloudflare.GoogleTagGateway"],
});

/**
 * Returns true if the given value is a GoogleTagGateway resource.
 */
export const isGoogleTagGateway = (value: unknown): value is GoogleTagGateway =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const GoogleTagGatewayProvider = () =>
  Provider.succeed(GoogleTagGateway, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialConfig"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this per-zone singleton — enumerate every
      // zone in the account and read its config. Unlike a true singleton,
      // the config is `null` for zones that never configured the feature,
      // so those zones contribute no row.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          googleTagGateway.getConfig({ zoneId }).pipe(
            Effect.map((observed) => {
              // `null` — the zone has never configured Google Tag Gateway.
              if (observed === null) return undefined;
              const config = toConfig(observed);
              return {
                zoneId,
                ...config,
                initialConfig: config,
              } satisfies Attributes;
            }),
            // Zone deleted out-of-band, or the scoped token can't see this
            // zone — skip it rather than failing the whole enumeration.
            Effect.catchTag(["InvalidRoute", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row) => row !== undefined);
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // The config belongs to the zone — moving zones is a replacement.
      const zoneId = yield* resolve(news.zone);
      if (zoneId !== output.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        // `olds.zone` may be `undefined` when a `creating` row was persisted
        // before upstream Outputs resolved — report "not found" then.
        output?.zoneId ??
        (olds?.zone !== undefined ? yield* resolve(olds.zone) : undefined);
      if (!zoneId) return undefined;
      const observed = yield* googleTagGateway.getConfig({ zoneId }).pipe(
        // Zone deleted out-of-band — the config is gone with it.
        Effect.catchTag("InvalidRoute", () => Effect.succeed(null)),
      );
      // `null` result — the zone has never configured Google Tag Gateway.
      if (observed === null) return undefined;
      // The config is a zone singleton with no ownership tags possible, so
      // a cold read adopts freely (never `Unowned`). The observed config at
      // adoption time becomes the `initialConfig` restored on destroy.
      const initialConfig =
        output !== undefined ? output.initialConfig : toConfig(observed);
      return { zoneId, ...toConfig(observed), initialConfig };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const zoneId = output?.zoneId ?? (yield* resolve(news.zone));

      // 1. Observe — `null` means the zone never configured the feature.
      const response = yield* googleTagGateway.getConfig({ zoneId });
      const observed = response === null ? undefined : toConfig(response);

      // 2. Capture — the pre-management config, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed config is
      //    the zone's original.
      const initialConfig =
        output !== undefined ? output.initialConfig : observed;

      // 3. Sync — PUT is a full replace; skip the call on no-op.
      const desired: Config = {
        enabled: news.enabled,
        endpoint: news.endpoint,
        hideOriginalIp: news.hideOriginalIp,
        // When omitted, retain whatever the zone currently has.
        setUpTag: news.setUpTag ?? observed?.setUpTag,
        measurementId: news.measurementId,
      };
      if (observed !== undefined && configEquals(observed, desired)) {
        return { zoneId, ...observed, initialConfig };
      }
      const updated = yield* googleTagGateway.putConfig({
        zoneId,
        enabled: desired.enabled,
        endpoint: desired.endpoint,
        hideOriginalIp: desired.hideOriginalIp,
        measurementId: desired.measurementId,
        setUpTag: desired.setUpTag,
      });
      return { zoneId, ...toConfig(updated), initialConfig };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialConfig } = output;
      // Observe — if the zone itself is gone, so is the config.
      const observed = yield* googleTagGateway
        .getConfig({ zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(null)));
      if (observed === null) return;
      // Restore the pre-management config. There is no DELETE API and the
      // PUT schema requires endpoint/measurementId, so a zone that had never
      // configured the feature is reset to a disabled baseline keeping the
      // last-known endpoint and measurement id.
      const target: Config = initialConfig ?? {
        enabled: false,
        endpoint: output.endpoint,
        hideOriginalIp: false,
        measurementId: output.measurementId,
        setUpTag: false,
      };
      // Skip the call when it already matches (idempotent re-delete after a
      // crashed run).
      if (configEquals(toConfig(observed), target)) return;
      yield* googleTagGateway
        .putConfig({
          zoneId,
          enabled: target.enabled,
          endpoint: target.endpoint,
          hideOriginalIp: target.hideOriginalIp,
          measurementId: target.measurementId,
          setUpTag: target.setUpTag,
        })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

const resolve = Effect.fn(function* (zone: Reference) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* resolveZoneId({
    accountId,
    zone,
    hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
  });
});

type ConfigResponse = NonNullable<
  googleTagGateway.GetConfigResponse | googleTagGateway.PutConfigResponse
>;

const toConfig = (response: ConfigResponse): Config => ({
  enabled: response.enabled,
  endpoint: response.endpoint,
  hideOriginalIp: response.hideOriginalIp,
  measurementId: response.measurementId,
  setUpTag: response.setUpTag ?? undefined,
});

const configEquals = (a: Config, b: Config): boolean =>
  a.enabled === b.enabled &&
  a.endpoint === b.endpoint &&
  a.hideOriginalIp === b.hideOriginalIp &&
  a.measurementId === b.measurementId &&
  (a.setUpTag ?? undefined) === (b.setUpTag ?? undefined);
