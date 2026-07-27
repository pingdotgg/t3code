import * as originTls from "@distilled.cloud/cloudflare/origin-tls-client-auth";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.OriginTlsClientAuth.Setting" as const;
type TypeId = typeof TypeId;

export type SettingProps = {
  /**
   * Zone the setting belongs to. Stable — changing the zone triggers a
   * replacement (the old zone's setting is restored to the value it had
   * before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether zone-level Authenticated Origin Pulls is enabled. When enabled,
   * Cloudflare presents the zone's uploaded client certificate
   * ({@link Certificate}) to your origin on every pull.
   *
   * Mutable — updated in place.
   * @default false (Cloudflare's default)
   */
  enabled: boolean;
};

export type SettingAttributes = {
  /** Zone the setting belongs to. */
  zoneId: string;
  /** Whether zone-level Authenticated Origin Pulls is currently enabled. */
  enabled: boolean;
  /**
   * The value the setting had before Alchemy first managed it. Restored on
   * destroy, so deleting the resource puts the zone back the way it was
   * found.
   */
  initialEnabled: boolean;
};

export type Setting = Resource<
  TypeId,
  SettingProps,
  SettingAttributes,
  never,
  Providers
>;

/**
 * The zone-level Authenticated Origin Pulls (AOP) toggle
 * (`/zones/{zone_id}/origin_tls_client_auth/settings`).
 *
 * The setting is a singleton — it always exists on every zone (Cloudflare
 * default `false`), so this resource never creates or deletes anything
 * physical. Reconcile flips the flag when the observed value differs from
 * the desired one; destroy restores the value the setting had before
 * Alchemy first managed it (captured as `initialEnabled`).
 *
 * Enabling AOP only has effect once a zone client certificate is uploaded
 * ({@link Certificate}) and your origin is configured to
 * verify it — enabling the flag alone does not break traffic unless the
 * origin enforces mTLS.
 * @resource
 * @product Origin TLS Client Auth
 * @category SSL/TLS & Certificates
 * @section Enabling Authenticated Origin Pulls
 * @example Enable zone-level AOP
 * ```typescript
 * const cert = yield* Cloudflare.OriginTlsClientAuth.Certificate("AopCert", {
 *   zoneId: zone.zoneId,
 *   certificate: clientCertPem,
 *   privateKey: alchemy.secret.env.AOP_CLIENT_KEY,
 * });
 *
 * yield* Cloudflare.OriginTlsClientAuth.Setting("Aop", {
 *   zoneId: zone.zoneId,
 *   enabled: true,
 * });
 * ```
 *
 * @example Pin AOP off
 * ```typescript
 * yield* Cloudflare.OriginTlsClientAuth.Setting("Aop", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/
 */
export const Setting = Resource<Setting>(TypeId);

/**
 * Returns true if the given value is an Setting resource.
 */
export const isSetting = (value: unknown): value is Setting =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SettingProvider = () =>
  Provider.succeed(Setting, {
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
          originTls.getSetting({ zoneId }).pipe(
            Effect.map((observed): SettingAttributes => {
              const enabled = observed.enabled ?? false;
              // Enumeration adopts the live value as the pre-management
              // baseline, mirroring a cold `read`.
              return { zoneId, enabled, initialEnabled: enabled };
            }),
            // Plan-gated or partial zones reject the route; skip them.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is SettingAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as SettingProps;
      const n = news as SettingProps;
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
      const observed = yield* originTls.getSetting({ zoneId });
      const enabled = observed.enabled ?? false;
      // The setting is a singleton that always exists with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts freely
      // (never `Unowned`). The observed value at adoption time becomes the
      // `initialEnabled` restored on destroy.
      const initialEnabled =
        output !== undefined ? output.initialEnabled : enabled;
      return { zoneId, enabled, initialEnabled };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the setting always exists; read its live value.
      const observed = yield* originTls.getSetting({ zoneId });
      const observedEnabled = observed.enabled ?? false;

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is the
      //    zone's original.
      const initialEnabled =
        output !== undefined ? output.initialEnabled : observedEnabled;

      // 3. Sync — put only when the observed value differs.
      if (observedEnabled === news.enabled) {
        return { zoneId, enabled: observedEnabled, initialEnabled };
      }
      const updated = yield* originTls.putSetting({
        zoneId,
        enabled: news.enabled,
      });
      return {
        zoneId,
        enabled: updated.enabled ?? news.enabled,
        initialEnabled,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialEnabled } = output;
      // Observe — restore the pre-management value; skip the call when it
      // already matches (idempotent re-delete after a crashed run).
      const observed = yield* originTls.getSetting({ zoneId });
      if ((observed.enabled ?? false) === initialEnabled) return;
      yield* originTls.putSetting({ zoneId, enabled: initialEnabled });
    }),
  });
