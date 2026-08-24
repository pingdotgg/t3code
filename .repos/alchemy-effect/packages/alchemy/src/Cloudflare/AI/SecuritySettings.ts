import * as aiSecurity from "@distilled.cloud/cloudflare/ai-security";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const AiSecuritySettingsTypeId = "Cloudflare.AI.SecuritySettings" as const;
type AiSecuritySettingsTypeId = typeof AiSecuritySettingsTypeId;

export type SecuritySettingsProps = {
  /**
   * Zone the AI Security settings belong to. Stable — changing the zone
   * triggers a replacement (the old zone's setting is restored to the
   * value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether AI Security for Apps (Firewall for AI) is enabled on the
   * zone. Mutable — toggled in place via PUT.
   *
   * @default false
   */
  enabled?: boolean;
};

export type SecuritySettingsAttributes = {
  /** Zone the AI Security settings belong to. */
  zoneId: string;
  /** Whether AI Security for Apps is currently enabled on the zone. */
  enabled: boolean;
  /**
   * The value `enabled` had before Alchemy first managed the setting.
   * Restored on destroy, so deleting the resource puts the zone back
   * the way it was found.
   */
  initialEnabled: boolean;
};

/**
 * Returns true if the given value is a SecuritySettings resource.
 */
export const isSecuritySettings = (value: unknown): value is SecuritySettings =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === AiSecuritySettingsTypeId;

export type SecuritySettings = Resource<
  AiSecuritySettingsTypeId,
  SecuritySettingsProps,
  SecuritySettingsAttributes,
  never,
  Providers
>;

/**
 * AI Security for Apps (Firewall for AI) settings on a Cloudflare zone
 * (`/zones/{zone_id}/ai-security/settings`).
 *
 * The settings object is a zone singleton — it always exists and is never
 * created or deleted, only toggled. Reconcile PUTs the desired `enabled`
 * value when the observed value differs; destroy restores the value the
 * zone had before Alchemy first managed it.
 *
 * Declare at most one `SecuritySettings` per zone — two instances
 * managing the same zone would fight over the single underlying setting.
 *
 * AI Security for Apps is entitlement-gated: on accounts without the
 * feature every call fails with the typed `AiSecurityNotEntitled` error
 * (Cloudflare error code 13101).
 * @resource
 * @product AI Security
 * @category Application Security
 * @section Enabling AI Security
 * @example Enable AI Security for Apps on a zone
 * ```typescript
 * const securitySettings = yield* Cloudflare.AI.SecuritySettings("AiSecurity", {
 *   zoneId: zone.zoneId,
 *   enabled: true,
 * });
 * ```
 *
 * @example Pin AI Security off
 * ```typescript
 * yield* Cloudflare.AI.SecuritySettings("AiSecurity", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/detections/firewall-for-ai/
 */
export const SecuritySettings = Resource<SecuritySettings>(
  AiSecuritySettingsTypeId,
  {
    aliases: ["Cloudflare.AiSecurity.Settings"],
  },
);

export const SecuritySettingsProvider = () =>
  Provider.succeed(SecuritySettings, {
    stables: ["zoneId", "initialEnabled"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting. The observed value at
      // read time is its own `initialEnabled` (nothing is being managed).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          aiSecurity.getAiSecurity({ zoneId }).pipe(
            Effect.map((observed): SecuritySettingsAttributes => {
              const enabled = observed.enabled ?? false;
              return { zoneId, enabled, initialEnabled: enabled };
            }),
            // Entitlement-gated or out-of-band-deleted zones reject the
            // route; skip them rather than failing the whole enumeration.
            Effect.catchTag("AiSecurityNotEntitled", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("ZoneNotAuthorized", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is SecuritySettingsAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as SecuritySettingsProps;
      const n = news as SecuritySettingsProps;
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
      const observed = yield* aiSecurity.getAiSecurity({ zoneId }).pipe(
        // Zone deleted out-of-band — the singleton is gone with it.
        Effect.catchTag("ZoneNotAuthorized", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      // The setting is a singleton that always exists with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts
      // freely (never `Unowned`). The observed value at adoption time
      // becomes the `initialEnabled` restored on destroy.
      const enabled = observed.enabled ?? false;
      const initialEnabled =
        output !== undefined ? output.initialEnabled : enabled;
      return { zoneId, enabled, initialEnabled };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desired = news.enabled ?? false;

      // 1. Observe — the singleton always exists; read its live value.
      const observed = yield* aiSecurity.getAiSecurity({ zoneId });
      const observedEnabled = observed.enabled ?? false;

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is
      //    the zone's original.
      const initialEnabled =
        output !== undefined ? output.initialEnabled : observedEnabled;

      // 3. Sync — PUT only when the observed value differs.
      if (observedEnabled === desired) {
        return { zoneId, enabled: observedEnabled, initialEnabled };
      }
      const updated = yield* aiSecurity.putAiSecurity({
        zoneId,
        enabled: desired,
      });
      return { zoneId, enabled: updated.enabled ?? desired, initialEnabled };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialEnabled } = output;
      // Observe — if the zone itself is gone, so is the setting; if the
      // entitlement was revoked, the setting is unreachable and there is
      // nothing we can restore.
      const observed = yield* aiSecurity.getAiSecurity({ zoneId }).pipe(
        Effect.catchTag("ZoneNotAuthorized", () => Effect.succeed(undefined)),
        Effect.catchTag("AiSecurityNotEntitled", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if ((observed.enabled ?? false) === initialEnabled) return;
      yield* aiSecurity
        .putAiSecurity({ zoneId, enabled: initialEnabled })
        .pipe(Effect.catchTag("ZoneNotAuthorized", () => Effect.void));
    }),
  });
