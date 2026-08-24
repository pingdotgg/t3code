import * as acm from "@distilled.cloud/cloudflare/acm";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Acm.TotalTls" as const;
type TypeId = typeof TypeId;

/**
 * The Certificate Authority Total TLS certificates are issued through.
 */
export type TotalTlsCertificateAuthority =
  | "google"
  | "lets_encrypt"
  | "ssl_com";

export interface TotalTlsProps {
  /**
   * Zone whose Total TLS setting is managed. Stable — changing the zone
   * triggers a replacement (the old zone's setting is restored to the
   * state it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Total TLS is enabled. When enabled, Cloudflare orders a
   * hostname-specific TLS certificate for every proxied A, AAAA, or CNAME
   * record in the zone. Mutable — updated in place.
   */
  enabled: boolean;
  /**
   * The Certificate Authority that Total TLS certificates will be issued
   * through. When omitted, Cloudflare picks one. Mutable — updated in
   * place.
   */
  certificateAuthority?: TotalTlsCertificateAuthority;
}

export interface TotalTlsAttributes {
  /** Zone the setting belongs to — this is the singleton's identity. */
  zoneId: string;
  /** Whether Total TLS is currently enabled on the zone. */
  enabled: boolean;
  /**
   * The Certificate Authority issuing Total TLS certificates, if
   * Cloudflare reports one.
   */
  certificateAuthority: string | undefined;
  /**
   * The validity period in days for certificates ordered via Total TLS
   * (currently always 90), if Cloudflare reports it.
   */
  validityPeriod: number | undefined;
  /**
   * Whether Total TLS was enabled before Alchemy first touched the zone.
   * Restored on destroy, so deleting the resource puts the zone back the
   * way it was found.
   */
  initialEnabled: boolean;
  /**
   * The Certificate Authority configured before Alchemy first touched the
   * zone, restored on destroy alongside `initialEnabled`.
   */
  initialCertificateAuthority: string | undefined;
}

export type TotalTls = Resource<
  TypeId,
  TotalTlsProps,
  TotalTlsAttributes,
  never,
  Providers
>;

/**
 * The Total TLS setting of a Cloudflare zone
 * (`/zones/{zone_id}/acm/total_tls`).
 *
 * Total TLS orders a hostname-specific TLS certificate for every proxied
 * A, AAAA, or CNAME record in the zone, covering deep subdomains that the
 * universal certificate's single-level wildcard cannot. The setting is a
 * zone **singleton** — it always exists (default disabled), so this
 * resource never creates or deletes anything physical. Reconcile posts the
 * setting when the observed state differs from the desired one; destroy
 * restores the state the zone had before Alchemy first managed it
 * (captured as `initialEnabled` / `initialCertificateAuthority`).
 *
 * **Entitlement-gated**: configuring Total TLS requires the Advanced
 * Certificate Manager add-on on the zone. Without it, every write fails
 * with the typed `AdvancedCertificateManagerRequired` (code 1450) error
 * (reads succeed and report `enabled: false`).
 *
 * Only one `TotalTls` resource per zone makes sense — two instances
 * managing the same zone would fight over the singleton.
 * @resource
 * @product ACM
 * @category SSL/TLS & Certificates
 * @section Managing Total TLS
 * @example Enable Total TLS on a zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Acm.TotalTls("TotalTls", {
 *   zoneId: zone.zoneId,
 *   enabled: true,
 * });
 * ```
 *
 * @example Pin the issuing Certificate Authority
 * ```typescript
 * yield* Cloudflare.Acm.TotalTls("TotalTls", {
 *   zoneId: zone.zoneId,
 *   enabled: true,
 *   certificateAuthority: "lets_encrypt",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
 */
export const TotalTls = Resource<TotalTls>(TypeId);

/**
 * Returns true if the given value is a TotalTls resource.
 */
export const isTotalTls = (value: unknown): value is TotalTls =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const TotalTlsProvider = () =>
  Provider.succeed(TotalTls, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialEnabled", "initialCertificateAuthority"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its setting (every zone has one,
      // defaulting to disabled; reads succeed even without the ACM
      // entitlement).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          acm.getTotalTl({ zoneId }).pipe(
            Effect.map((observed) =>
              toAttributes(
                zoneId,
                observed,
                initialStateOf(undefined, observed),
              ),
            ),
            // Zone deleted out-of-band between enumeration and read.
            Effect.catchTag("InvalidObjectIdentifier", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is TotalTlsAttributes => row !== undefined);
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
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
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* acm.getTotalTl({ zoneId }).pipe(
        // Zone deleted out-of-band — the setting is gone with it.
        Effect.catchTag("InvalidObjectIdentifier", () =>
          Effect.succeed(undefined),
        ),
      );
      if (observed === undefined) return undefined;
      // The setting is a singleton that always exists with a Cloudflare
      // default — there is nothing to "own", so a cold read adopts freely
      // (never `Unowned`). The observed state at adoption time becomes the
      // initial state restored on destroy.
      return toAttributes(zoneId, observed, initialStateOf(output, observed));
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the setting always exists; read its live state.
      //    (Reads succeed even on zones without the ACM entitlement.)
      const observed = yield* acm.getTotalTl({ zoneId });

      // 2. Capture — the pre-management state, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed state is
      //    the zone's original.
      const initial = initialStateOf(output, observed);

      // 3. Sync — post only when the observed state differs. Zones
      //    without the ACM entitlement fail here with the typed
      //    `AdvancedCertificateManagerRequired` error.
      if (matchesDesired(observed, news)) {
        return toAttributes(zoneId, observed, initial);
      }
      const updated = yield* acm
        .updateTotalTl({
          zoneId,
          enabled: news.enabled,
          certificateAuthority: news.certificateAuthority,
        })
        .pipe(
          // A concurrent actor already applied the same state — converge
          // by re-reading instead of failing.
          Effect.catchTag("NoStateChange", () => acm.getTotalTl({ zoneId })),
          // Cloudflare serializes Total TLS jobs per zone; ride out a
          // previous job finishing (bounded).
          Effect.retry({
            while: (e) => e._tag === "PreviousJobInProgress",
            schedule: Schedule.spaced("3 seconds"),
            times: 10,
          }),
        );
      return toAttributes(zoneId, updated, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialEnabled, initialCertificateAuthority } = output;
      // Observe — if the zone itself is gone, so is the setting.
      const observed = yield* acm
        .getTotalTl({ zoneId })
        .pipe(
          Effect.catchTag("InvalidObjectIdentifier", () =>
            Effect.succeed(undefined),
          ),
        );
      if (observed === undefined) return;
      // Restore the pre-management state; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (
        (observed.enabled ?? false) === initialEnabled &&
        (initialCertificateAuthority === undefined ||
          (observed.certificateAuthority ?? undefined) ===
            initialCertificateAuthority)
      ) {
        return;
      }
      yield* acm
        .updateTotalTl({
          zoneId,
          enabled: initialEnabled,
          // The request type accepts any string (`(string & {})`), so the
          // captured initial CA round-trips without a cast.
          certificateAuthority: initialCertificateAuthority,
        })
        .pipe(
          Effect.catchTag("InvalidObjectIdentifier", () => Effect.void),
          Effect.catchTag("NoStateChange", () => Effect.void),
          // The zone lost its ACM entitlement since we configured it —
          // Cloudflare already refuses Total TLS writes, so there is
          // nothing left to restore.
          Effect.catchTag(
            "AdvancedCertificateManagerRequired",
            () => Effect.void,
          ),
          Effect.retry({
            while: (e) => e._tag === "PreviousJobInProgress",
            schedule: Schedule.spaced("3 seconds"),
            times: 10,
          }),
          Effect.asVoid,
        );
    }),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ObservedTotalTls = acm.GetTotalTlResponse | acm.UpdateTotalTlResponse;

/**
 * The pre-management state restored on destroy: carried forward on
 * `output` once captured, otherwise derived from the first observation.
 */
const initialStateOf = (
  output: TotalTlsAttributes | undefined,
  observed: ObservedTotalTls,
): Pick<
  TotalTlsAttributes,
  "initialEnabled" | "initialCertificateAuthority"
> =>
  output !== undefined
    ? {
        initialEnabled: output.initialEnabled,
        initialCertificateAuthority: output.initialCertificateAuthority,
      }
    : {
        initialEnabled: observed.enabled ?? false,
        initialCertificateAuthority: observed.certificateAuthority ?? undefined,
      };

/**
 * Whether the observed setting already matches the desired props — the
 * certificate authority only participates when explicitly requested
 * (Cloudflare picks one otherwise).
 */
const matchesDesired = (
  observed: ObservedTotalTls,
  news: TotalTlsProps,
): boolean =>
  (observed.enabled ?? false) === news.enabled &&
  (news.certificateAuthority === undefined ||
    (observed.certificateAuthority ?? undefined) === news.certificateAuthority);

const toAttributes = (
  zoneId: string,
  setting: ObservedTotalTls,
  initial: Pick<
    TotalTlsAttributes,
    "initialEnabled" | "initialCertificateAuthority"
  >,
): TotalTlsAttributes => ({
  zoneId,
  enabled: setting.enabled ?? false,
  certificateAuthority: setting.certificateAuthority ?? undefined,
  validityPeriod: setting.validityPeriod ?? undefined,
  ...initial,
});
