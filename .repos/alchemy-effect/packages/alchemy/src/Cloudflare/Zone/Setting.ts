import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "./lookup.ts";

const TypeId = "Cloudflare.Zone.Setting" as const;
type TypeId = typeof TypeId;

/**
 * Identifier of a Cloudflare zone setting — every value Cloudflare
 * recognises on `/zones/{zone_id}/settings/{settingId}`. The open
 * `(string & {})` tail keeps the type forward-compatible with settings
 * Cloudflare adds later.
 */
export type SettingId =
  | "0rtt"
  | "advanced_ddos"
  | "aegis"
  | "always_online"
  | "always_use_https"
  | "automatic_https_rewrites"
  | "automatic_platform_optimization"
  | "brotli"
  | "browser_cache_ttl"
  | "browser_check"
  | "cache_level"
  | "challenge_ttl"
  | "china_network_enabled"
  | "ciphers"
  | "cname_flattening"
  | "content_converter"
  | "development_mode"
  | "early_hints"
  | "edge_cache_ttl"
  | "email_obfuscation"
  | "h2_prioritization"
  | "hotlink_protection"
  | "http2"
  | "http3"
  | "image_resizing"
  | "ip_geolocation"
  | "ipv6"
  | "max_upload"
  | "min_tls_version"
  | "mirage"
  | "nel"
  | "opportunistic_encryption"
  | "opportunistic_onion"
  | "orange_to_orange"
  | "origin_error_page_pass_thru"
  | "origin_h2_max_streams"
  | "origin_max_http_version"
  | "polish"
  | "prefetch_preload"
  | "privacy_pass"
  | "proxy_read_timeout"
  | "pseudo_ipv4"
  | "redirects_for_ai_training"
  | "replace_insecure_js"
  | "response_buffering"
  | "rocket_loader"
  | "search_for_agents"
  | "security_header"
  | "security_level"
  | "server_side_exclude"
  | "sha1_support"
  | "sort_query_string_for_cache"
  | "ssl"
  | "tls_1_2_only"
  | "tls_1_3"
  | "tls_client_auth"
  | "transformations"
  | "transformations_allowed_origins"
  | "true_client_ip_header"
  | "waf"
  | "webp"
  | "websockets"
  | (string & {});

/**
 * The concrete, enumerable members of {@link SettingId}. Cloudflare has no
 * "list all settings" operation in the distilled `zones` service (only a
 * per-setting `getSetting`), so `list()` fans out a `getSetting` over this
 * known set on every zone. Forward-compatible settings (the `(string & {})`
 * tail) cannot be enumerated and are skipped by definition.
 */
const KNOWN_ZONE_SETTING_IDS = [
  "0rtt",
  "advanced_ddos",
  "aegis",
  "always_online",
  "always_use_https",
  "automatic_https_rewrites",
  "automatic_platform_optimization",
  "brotli",
  "browser_cache_ttl",
  "browser_check",
  "cache_level",
  "challenge_ttl",
  "china_network_enabled",
  "ciphers",
  "cname_flattening",
  "content_converter",
  "development_mode",
  "early_hints",
  "edge_cache_ttl",
  "email_obfuscation",
  "h2_prioritization",
  "hotlink_protection",
  "http2",
  "http3",
  "image_resizing",
  "ip_geolocation",
  "ipv6",
  "max_upload",
  "min_tls_version",
  "mirage",
  "nel",
  "opportunistic_encryption",
  "opportunistic_onion",
  "orange_to_orange",
  "origin_error_page_pass_thru",
  "origin_h2_max_streams",
  "origin_max_http_version",
  "polish",
  "prefetch_preload",
  "privacy_pass",
  "proxy_read_timeout",
  "pseudo_ipv4",
  "redirects_for_ai_training",
  "replace_insecure_js",
  "response_buffering",
  "rocket_loader",
  "search_for_agents",
  "security_header",
  "security_level",
  "server_side_exclude",
  "sha1_support",
  "sort_query_string_for_cache",
  "ssl",
  "tls_1_2_only",
  "tls_1_3",
  "tls_client_auth",
  "transformations",
  "transformations_allowed_origins",
  "true_client_ip_header",
  "waf",
  "webp",
  "websockets",
] as const satisfies readonly SettingId[];

export type SettingProps = {
  /**
   * Zone the setting belongs to. Stable — changing the zone triggers a
   * replacement (the old zone's setting is restored to the value it had
   * before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Which zone setting to manage (e.g. `always_online`,
   * `browser_cache_ttl`, `min_tls_version`). Stable — the setting id is
   * the resource's identity, so changing it triggers a replacement.
   *
   * Declared as plain `string` (narrowed to {@link SettingId}) so
   * `diff` can compare without resolving an `Input`.
   */
  settingId: SettingId;
  /**
   * Desired value of the setting. The shape depends on `settingId` —
   * on/off toggles take `"on"`/`"off"`, `browser_cache_ttl` takes a
   * number of seconds, structured settings (e.g. `ciphers`,
   * `security_header`) take arrays/objects.
   *
   * Mutable — patched in place.
   */
  value: unknown;
};

export type SettingAttributes = {
  /** Zone the setting belongs to. */
  zoneId: string;
  /** The managed setting's identifier. */
  settingId: string;
  /** Resolved current value of the setting. */
  value: unknown;
  /**
   * Whether the setting can be modified on the zone's current plan
   * (`false` means the setting is plan-gated).
   */
  editable: boolean | undefined;
  /** When the setting was last modified, if Cloudflare reports it. */
  modifiedOn: string | undefined;
  /**
   * The value the setting had before Alchemy first patched it. Restored
   * on destroy, so deleting the resource puts the zone back the way it
   * was found.
   */
  initialValue: unknown;
};

export type Setting = Resource<
  TypeId,
  SettingProps,
  SettingAttributes,
  never,
  Providers
>;

/**
 * A single Cloudflare zone setting (`/zones/{zone_id}/settings/{settingId}`)
 * pinned to a desired value.
 *
 * Zone settings are singletons — every setting always exists on every zone
 * (with a Cloudflare default), so this resource never creates or deletes
 * anything physical. Reconcile patches the setting when the observed value
 * differs from the desired one; destroy restores the value the setting had
 * before Alchemy first managed it (captured as `initialValue`).
 *
 * Many settings are plan-gated (`editable: false` on lower plans — e.g.
 * `image_resizing`, `polish` need Pro+; `advanced_ddos` is Enterprise).
 * Patching a non-editable setting fails with Cloudflare's "setting not
 * editable" error.
 * @resource
 * @product Zones
 * @category Domains & DNS
 * @section Toggle settings
 * @example Force HTTPS on the whole zone
 * ```typescript
 * yield* Cloudflare.Zone.Setting("AlwaysUseHttps", {
 *   zoneId: zone.zoneId,
 *   settingId: "always_use_https",
 *   value: "on",
 * });
 * ```
 *
 * @example Disable Always Online
 * ```typescript
 * yield* Cloudflare.Zone.Setting("AlwaysOnline", {
 *   zoneId: zone.zoneId,
 *   settingId: "always_online",
 *   value: "off",
 * });
 * ```
 *
 * @section Numeric settings
 * @example Browser cache TTL of one hour
 * ```typescript
 * yield* Cloudflare.Zone.Setting("BrowserCacheTtl", {
 *   zoneId: zone.zoneId,
 *   settingId: "browser_cache_ttl",
 *   value: 3600,
 * });
 * ```
 *
 * @section TLS settings
 * @example Require at least TLS 1.2
 * ```typescript
 * yield* Cloudflare.Zone.Setting("MinTls", {
 *   zoneId: zone.zoneId,
 *   settingId: "min_tls_version",
 *   value: "1.2",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api/resources/zones/subresources/settings/
 */
export const Setting = Resource<Setting>(TypeId);

/**
 * Returns true if the given value is a Setting resource.
 */
export const isSetting = (value: unknown): value is Setting =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SettingProvider = () =>
  Provider.succeed(Setting, {
    stables: ["zoneId", "settingId", "initialValue"],

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as SettingProps;
      const n = news as SettingProps;
      // settingId is the resource's identity.
      const oldSettingId = output?.settingId ?? o.settingId;
      if (oldSettingId !== undefined && oldSettingId !== n.settingId) {
        return { action: "replace" } as const;
      }
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
      const settingId = output?.settingId ?? olds?.settingId;
      if (!zoneId || !settingId) return undefined;
      const observed = yield* zones.getSetting({ zoneId, settingId }).pipe(
        // Zone deleted out-of-band — the setting is gone with it.
        Effect.catchTag("InvalidZoneIdentifier", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return undefined;
      // Settings are singletons that always exist with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts
      // freely (never `Unowned`). The observed value at adoption time
      // becomes the `initialValue` restored on destroy.
      const initialValue =
        output !== undefined ? output.initialValue : settingValue(observed);
      return toAttributes(zoneId, settingId, observed, initialValue);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const settingId = news.settingId;

      // 1. Observe — the setting always exists; read its live value.
      const observed = yield* zones.getSetting({ zoneId, settingId });

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is
      //    the zone's original.
      const initialValue =
        output !== undefined ? output.initialValue : settingValue(observed);

      // 3. Sync — patch only when the observed value differs.
      if (deepValueEquals(settingValue(observed), news.value)) {
        return toAttributes(zoneId, settingId, observed, initialValue);
      }
      const patched = yield* zones.patchSetting({
        zoneId,
        settingId,
        value: news.value,
      });
      return toAttributes(zoneId, settingId, patched, initialValue);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, settingId, initialValue } = output;
      // Observe — if the zone itself is gone, so is the setting.
      const observed = yield* zones
        .getSetting({ zoneId, settingId })
        .pipe(
          Effect.catchTag("InvalidZoneIdentifier", () =>
            Effect.succeed(undefined),
          ),
        );
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (deepValueEquals(settingValue(observed), initialValue)) return;
      yield* zones
        .patchSetting({ zoneId, settingId, value: initialValue })
        .pipe(Effect.catchTag("InvalidZoneIdentifier", () => Effect.void));
    }),

    // Zone settings are keyed by (zoneId, settingId): every setting exists on
    // every zone with a Cloudflare default. There is no account-wide list, so
    // enumerate every zone via `listAllZones` and read each known setting with
    // the same `getSetting` call `read` uses — emitting one Attributes per
    // (zone, setting), exactly matching `read`'s keying.
    //
    // The distilled `zones` service exposes only a per-setting `getSetting`
    // (no bulk `/zones/{id}/settings` list op), so we fan out across the known
    // setting ids. Adding a bulk-list operation to distilled would collapse
    // each zone's N gets into one call — see the agent report's neededPatch.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const allZones = yield* listAllZones(accountId);
      const pairs = allZones.flatMap((zone) =>
        KNOWN_ZONE_SETTING_IDS.map((settingId) => ({
          zoneId: zone.id,
          settingId,
        })),
      );
      const rows = yield* Effect.forEach(
        pairs,
        ({ zoneId, settingId }) =>
          zones.getSetting({ zoneId, settingId }).pipe(
            Effect.map((observed) =>
              // Unmanaged at discovery time, so the observed value is the
              // setting's pre-management value (mirrors a cold `read`).
              toAttributes(zoneId, settingId, observed, settingValue(observed)),
            ),
            // Zone removed out-of-band or the setting is plan-gated / not
            // exposed to this token — skip it rather than fail the listing.
            Effect.catchTag(["InvalidZoneIdentifier", "Forbidden"], () =>
              Effect.succeed<SettingAttributes | undefined>(undefined),
            ),
            // A handful of structured settings (e.g.
            // `automatic_platform_optimization`) can return a scalar value
            // (`"off"`) that distilled's `GetSettingResponse` union doesn't
            // model, surfacing as an untyped `CloudflareHttpError` (status
            // 200, "Schema decode failed"). The Cloudflare patch system only
            // types errors, not response schemas, so this can't be patched
            // here — skip the undecodable setting rather than failing the
            // whole listing. See the agent report's neededPatch (widen the
            // `GetSettingResponse` member to accept the scalar form).
            Effect.catch(() =>
              Effect.succeed<SettingAttributes | undefined>(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is SettingAttributes => row !== undefined);
    }),
  });

/**
 * Pull the `value` out of a distilled setting response. Every member of the
 * response union carries `value` (a couple type it optional), so widen
 * rather than switch on all sixty setting ids.
 */
const settingValue = (
  setting: zones.GetSettingResponse | zones.PatchSettingResponse,
): unknown => (setting as { value?: unknown }).value;

const toAttributes = (
  zoneId: string,
  settingId: string,
  setting: zones.GetSettingResponse | zones.PatchSettingResponse,
  initialValue: unknown,
): SettingAttributes => {
  const s = setting as {
    value?: unknown;
    editable?: boolean | null;
    modifiedOn?: string | null;
  };
  return {
    zoneId,
    settingId,
    value: s.value,
    editable: s.editable ?? undefined,
    modifiedOn: s.modifiedOn ?? undefined,
    initialValue,
  };
};

/**
 * Structural equality for setting values — primitives, arrays, and plain
 * objects (`null`-tolerant). Setting values are plain JSON, so this is
 * sufficient and avoids key-order false negatives that `JSON.stringify`
 * comparison would produce.
 */
const deepValueEquals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepValueEquals(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepValueEquals(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
};
