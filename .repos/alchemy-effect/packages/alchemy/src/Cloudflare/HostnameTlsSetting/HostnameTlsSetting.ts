import * as hostnames from "@distilled.cloud/cloudflare/hostnames";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.HostnameTlsSetting.HostnameTlsSetting" as const;
type TypeId = typeof TypeId;

/**
 * Which per-hostname TLS setting to override:
 *
 * - `ciphers` — allowed cipher suites (BoringSSL names) for the hostname
 * - `min_tls_version` — minimum TLS protocol version for the hostname
 * - `http2` — whether HTTP/2 is offered to clients connecting to the hostname
 */
export type Id = "ciphers" | "min_tls_version" | "http2";

/**
 * The value of a per-hostname TLS setting. The shape depends on
 * {@link Id}:
 *
 * - `ciphers` → `string[]` of BoringSSL cipher suite names
 * - `min_tls_version` → `"1.0" | "1.1" | "1.2" | "1.3"`
 * - `http2` → `"on" | "off"`
 */
export type Value = "1.0" | "1.1" | "1.2" | "1.3" | "on" | "off" | string[];

export interface Props {
  /**
   * Zone the hostname belongs to. Stable — moving the override to another
   * zone triggers a replacement.
   */
  zoneId: string;
  /**
   * Which TLS setting to override (`ciphers`, `min_tls_version`, or
   * `http2`). Part of the override's identity — changing it triggers a
   * replacement.
   */
  settingId: Id;
  /**
   * The hostname the override applies to. Part of the override's identity —
   * changing it triggers a replacement.
   *
   * Per-hostname TLS settings require the hostname to be covered by
   * Cloudflare for SaaS custom hostnames or an Advanced Certificate
   * Manager certificate on the zone; without that entitlement the API
   * rejects writes with `AdvancedCertificateManagerRequired`.
   */
  hostname: string;
  /**
   * Desired value of the setting. The shape depends on `settingId`:
   * `ciphers` takes a `string[]` of BoringSSL cipher names,
   * `min_tls_version` takes `"1.0" | "1.1" | "1.2" | "1.3"`, and `http2`
   * takes `"on" | "off"`.
   *
   * Mutable — upserted in place via PUT.
   */
  value: Value;
}

export interface Attributes {
  /** Zone the hostname belongs to. */
  zoneId: string;
  /** The overridden TLS setting's identifier. */
  settingId: string;
  /** The hostname the override applies to. */
  hostname: string;
  /** Current value of the override. */
  value: Value;
  /**
   * Deployment status of the override (e.g. `pending_deployment`,
   * `active`). Propagation to the edge is asynchronous.
   */
  status: string | undefined;
  /** When the override was first created, if Cloudflare reports it. */
  createdAt: string | undefined;
  /** When the override was last updated, if Cloudflare reports it. */
  updatedAt: string | undefined;
}

export type HostnameTlsSetting = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * A per-hostname TLS setting override
 * (`/zones/{zone_id}/hostnames/settings/{settingId}/{hostname}`) — pins
 * `ciphers`, `min_tls_version`, or `http2` for a single hostname instead of
 * the whole zone.
 *
 * Each `(settingId, hostname)` pair is an independent override with PUT
 * (upsert) / DELETE semantics; deleting the override reverts the hostname to
 * the zone-wide default. Overrides are mostly useful with Cloudflare for
 * SaaS custom hostnames or Advanced Certificate Manager — on zones without
 * that entitlement, writes fail with the typed
 * `AdvancedCertificateManagerRequired` error (Cloudflare code 1450).
 *
 * Safety: overrides carry no ownership markers. When there is no prior
 * state, `read` scans the setting's hostname list and reports an existing
 * override as `Unowned`, so the engine refuses to take it over unless
 * `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Hostname TLS Settings
 * @category SSL/TLS & Certificates
 * @section Minimum TLS version
 * @example Require TLS 1.2 for a single hostname
 * ```typescript
 * yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting("ApiMinTls", {
 *   zoneId: zone.zoneId,
 *   settingId: "min_tls_version",
 *   hostname: "api.example.com",
 *   value: "1.2",
 * });
 * ```
 *
 * @section HTTP/2
 * @example Disable HTTP/2 for a legacy hostname
 * ```typescript
 * yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting("LegacyHttp2", {
 *   zoneId: zone.zoneId,
 *   settingId: "http2",
 *   hostname: "legacy.example.com",
 *   value: "off",
 * });
 * ```
 *
 * @section Cipher suites
 * @example Restrict a hostname to modern ciphers
 * ```typescript
 * yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting("StrictCiphers", {
 *   zoneId: zone.zoneId,
 *   settingId: "ciphers",
 *   hostname: "secure.example.com",
 *   value: ["ECDHE-RSA-AES128-GCM-SHA256", "AES128-GCM-SHA256"],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/edge-certificates/additional-options/custom-metadata/
 * @see https://developers.cloudflare.com/api/resources/hostnames/subresources/settings/subresources/tls/
 */
export const HostnameTlsSetting = Resource<HostnameTlsSetting>(TypeId, {
  aliases: ["Cloudflare.HostnameTlsSetting"],
});

/**
 * Returns true if the given value is a HostnameTlsSetting resource.
 */
export const isHostnameTlsSetting = (
  value: unknown,
): value is HostnameTlsSetting =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const HostnameTlsSettingProvider = () =>
  Provider.succeed(HostnameTlsSetting, {
    stables: ["zoneId", "settingId", "hostname", "createdAt"],

    list: Effect.fn(function* () {
      // No account-wide enumeration: overrides live under
      // `/zones/{zone_id}/hostnames/settings/{settingId}` and are keyed by
      // (zone, settingId, hostname). Enumerate every zone, then list each
      // of the three TLS settings, paginating exhaustively, and flatten one
      // row per (settingId, hostname) override.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const settingIds: Id[] = ["ciphers", "min_tls_version", "http2"];
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          Effect.forEach(
            settingIds,
            (settingId) =>
              hostnames.getSettingTls
                .pages({ zoneId: zone.id, settingId })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) =>
                      page.result.flatMap((entry) =>
                        entry.hostname == null
                          ? []
                          : [
                              toAttributes(
                                zone.id,
                                settingId,
                                entry.hostname,
                                entry,
                              ),
                            ],
                      ),
                    ),
                  ),
                  // Zones without Advanced Certificate Manager / Cloudflare
                  // for SaaS reject the route, and a scoped token may lack
                  // access to a zone — skip those rather than fail the whole
                  // enumeration.
                  Effect.catchTag(
                    ["AdvancedCertificateManagerRequired", "Forbidden"],
                    () => Effect.succeed([] as Attributes[]),
                  ),
                ),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((perSetting) => perSetting.flat())),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      // `news` may still carry unresolved plan-time expressions — defer to
      // the engine's default update logic until everything is concrete.
      if (!isResolved(news)) return undefined;
      // (settingId, hostname) is the override's identity.
      const oldSettingId = output?.settingId ?? olds?.settingId;
      if (oldSettingId !== undefined && oldSettingId !== news.settingId) {
        return { action: "replace" } as const;
      }
      const oldHostname = output?.hostname ?? olds?.hostname;
      if (oldHostname !== undefined && oldHostname !== news.hostname) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; compare only once both sides are concrete.
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
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      const settingId = output?.settingId ?? olds?.settingId;
      const hostname = output?.hostname ?? olds?.hostname;
      if (!zoneId || !settingId || !hostname) return undefined;

      const observed = yield* findSetting(zoneId, settingId, hostname);
      if (observed === undefined) return undefined;

      const attrs = toAttributes(zoneId, settingId, hostname, observed);
      // Overrides carry no ownership markers — on a cold read (no prior
      // state) we cannot prove we created it, so brand it `Unowned` and
      // let the engine gate takeover behind the adopt policy.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const { settingId, hostname } = news;

      // 1. Observe — there is no per-hostname GET; list the setting's
      //    overrides and match on hostname.
      const observed = yield* findSetting(zoneId, settingId, hostname);

      // 2. Sync — PUT is a true upsert, so a single call covers both the
      //    missing and the drifted case; skip it entirely on a no-op.
      if (observed !== undefined && valueEquals(observed.value, news.value)) {
        return toAttributes(zoneId, settingId, hostname, observed);
      }
      const updated = yield* hostnames.putSettingTls({
        zoneId,
        settingId,
        hostname,
        value: news.value,
      });
      // The list can briefly echo a stale value after the PUT (edge
      // deployment is async) — trust the PUT response, not a re-read.
      return toAttributes(zoneId, settingId, hostname, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, settingId, hostname } = output;
      // Observe first — deleting an already-removed override is not an
      // error (idempotent re-delete after a crashed run).
      const observed = yield* findSetting(zoneId, settingId, hostname);
      if (observed === undefined) return;
      yield* hostnames.deleteSettingTls({ zoneId, settingId, hostname }).pipe(
        // Lost a race with an out-of-band delete — already converged.
        Effect.catchTag("HostnameTlsSettingNotFound", () => Effect.void),
      );
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type ObservedSetting = hostnames.GetSettingTlsResponse["result"][number];

/**
 * Find the override for `hostname` in the setting's hostname list — the API
 * has no per-hostname GET. Missing → `undefined`.
 */
const findSetting = (zoneId: string, settingId: string, hostname: string) =>
  hostnames
    .getSettingTls({ zoneId, settingId })
    .pipe(
      Effect.map((response) =>
        response.result.find((entry) => entry.hostname === hostname),
      ),
    );

/**
 * Structural equality for setting values — scalar versions/toggles compare
 * by identity, cipher lists element-wise (order matters: the list is the
 * client-facing preference order).
 */
const valueEquals = (a: ObservedSetting["value"], b: Value): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
};

const toAttributes = (
  zoneId: string,
  settingId: string,
  hostname: string,
  setting: ObservedSetting | hostnames.PutSettingTlsResponse,
): Attributes => ({
  zoneId,
  settingId,
  hostname,
  value: normalizeValue(setting.value),
  status: setting.status ?? undefined,
  createdAt: setting.createdAt ?? undefined,
  updatedAt: setting.updatedAt ?? undefined,
});

/**
 * Distilled types the echoed value as nullable and cipher arrays as
 * `readonly string[]` — normalize to the props-facing shape. A persisted
 * override always carries a value; fall back to `"off"` purely to satisfy
 * the type.
 */
const normalizeValue = (value: ObservedSetting["value"]): Value =>
  value === null || value === undefined
    ? "off"
    : Array.isArray(value)
      ? [...value]
      : value;
