import * as lcc from "@distilled.cloud/cloudflare/leaked-credential-checks";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId =
  "Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck" as const;
type TypeId = typeof TypeId;

export interface Props {
  /**
   * Zone whose Leaked Credential Checks setting is managed. Stable —
   * changing the zone triggers a replacement (the old zone's setting is
   * restored to the value it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Leaked Credential Checks are enabled on the zone. Mutable —
   * set in place via the API's POST upsert.
   * @default true
   */
  enabled?: boolean;
}

export interface Attributes {
  /** Zone the setting belongs to. */
  zoneId: string;
  /** Whether Leaked Credential Checks are currently enabled. */
  enabled: boolean;
  /**
   * The value the setting had before Alchemy first managed it. Restored
   * on destroy, so deleting the resource puts the zone back the way it
   * was found.
   */
  initialEnabled: boolean;
}

export type LeakedCredentialCheck = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * The Leaked Credential Checks setting of a Cloudflare zone
 * (`/zones/{zone_id}/leaked-credential-checks`).
 *
 * Leaked credential detection scans incoming requests for authentication
 * credentials previously seen in known breach compilations, populating the
 * `cf.waf.credential_check.*` ruleset fields that WAF rules can act on
 * (e.g. force a password reset on a leaked-credential login). The check is
 * a zone **singleton** — it always exists (default `enabled: false`), so
 * this resource never creates or deletes anything physical. Reconcile sets
 * the flag when the observed value differs from the desired one; destroy
 * restores the value the setting had before Alchemy first managed it
 * (captured as `initialEnabled`).
 *
 * Leaked-credential detection is available on all plans. Custom detection
 * locations (see {@link LeakedCredentialDetection}) are plan-gated
 * separately.
 *
 * Only one `LeakedCredentialCheck` resource per zone makes sense — two
 * instances managing the same zone would fight over the singleton.
 * @resource
 * @product Leaked Credential Checks
 * @category Application Security
 * @section Managing the check
 * @example Enable Leaked Credential Checks on a zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
 *   zoneId: zone.zoneId,
 * });
 * ```
 *
 * @example Explicitly pin the check off
 * ```typescript
 * yield* Cloudflare.LeakedCredentialCheck.LeakedCredentialCheck("Lcc", {
 *   zoneId: zone.zoneId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/detections/leaked-credentials/
 */
export const LeakedCredentialCheck = Resource<LeakedCredentialCheck>(TypeId, {
  aliases: ["Cloudflare.LeakedCredentialCheck"],
});

/**
 * Returns true if the given value is a LeakedCredentialCheck resource.
 */
export const isLeakedCredentialCheck = (
  value: unknown,
): value is LeakedCredentialCheck =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

const desiredEnabled = (props: Props): boolean => props.enabled ?? true;

export const LeakedCredentialCheckProvider = () =>
  Provider.succeed(LeakedCredentialCheck, {
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
          lcc.getLeakedCredentialCheck({ zoneId }).pipe(
            Effect.map((observed) => {
              const enabled = observed.enabled ?? false;
              // The singleton always exists; with no managed history its
              // observed value is also its pre-management value.
              return {
                zoneId,
                enabled,
                initialEnabled: enabled,
              } satisfies Attributes;
            }),
            // Zone deleted out-of-band or plan-gated route; skip it.
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
      const observed = yield* lcc.getLeakedCredentialCheck({ zoneId });
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

      // 1. Observe — the setting always exists; read its live value.
      const observed = yield* lcc.getLeakedCredentialCheck({ zoneId });
      const observedEnabled = observed.enabled ?? false;

      // 2. Capture — the pre-management value, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed value is
      //    the zone's original.
      const initialEnabled =
        output !== undefined ? output.initialEnabled : observedEnabled;

      // 3. Sync — POST (the API's set/upsert) only when it differs.
      const desired = desiredEnabled(news);
      if (observedEnabled === desired) {
        return { zoneId, enabled: observedEnabled, initialEnabled };
      }
      const set = yield* lcc.createLeakedCredentialCheck({
        zoneId,
        enabled: desired,
      });
      return { zoneId, enabled: set.enabled ?? desired, initialEnabled };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialEnabled } = output;
      // Observe, then restore the pre-management value; skip the call
      // when it already matches (idempotent re-delete after a crashed
      // run). The singleton always exists, so nothing here can 404.
      const observed = yield* lcc.getLeakedCredentialCheck({ zoneId });
      if ((observed.enabled ?? false) === initialEnabled) return;
      yield* lcc.createLeakedCredentialCheck({
        zoneId,
        enabled: initialEnabled,
      });
    }),
  });
