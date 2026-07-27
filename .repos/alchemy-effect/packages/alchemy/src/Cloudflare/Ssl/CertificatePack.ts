import * as ssl from "@distilled.cloud/cloudflare/ssl";
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

const TypeId = "Cloudflare.Ssl.CertificatePack" as const;
type TypeId = typeof TypeId;

/**
 * Certificate Authorities available for Advanced Certificate Manager orders.
 *
 * - `google` — Google Trust Services
 * - `lets_encrypt` — Let's Encrypt (no `cloudflareBranding`)
 * - `ssl_com` — SSL.com (supports `email` validation)
 */
export type CertificatePackCertificateAuthority =
  | "google"
  | "lets_encrypt"
  | "ssl_com";

/**
 * Domain Control Validation method used to prove ownership of the
 * certificate's hostnames.
 */
export type CertificatePackValidationMethod = "txt" | "http" | "email";

/**
 * Number of days the issued certificates are valid for.
 */
export type CertificatePackValidityDays = 14 | 30 | 90 | 365;

/**
 * Status of a certificate pack as reported by Cloudflare.
 */
export type CertificatePackStatus =
  | "initializing"
  | "pending_validation"
  | "deleted"
  | "pending_issuance"
  | "pending_deployment"
  | "pending_deletion"
  | "pending_expiration"
  | "expired"
  | "active"
  | "initializing_timed_out"
  | "validation_timed_out"
  | "issuance_timed_out"
  | "deployment_timed_out"
  | "deletion_timed_out"
  | "pending_cleanup"
  | "staging_deployment"
  | "staging_active"
  | "deactivating"
  | "inactive"
  | "backup_issued"
  | "holding_deployment";

/**
 * A Domain Control Validation record for a certificate pack — create the
 * indicated TXT/CNAME record (or serve the HTTP token) to complete
 * validation when the pack is `pending_validation`.
 */
export interface CertificatePackValidationRecord {
  /** Name of the TXT record to create (for `txt` validation). */
  txtName?: string;
  /** Value of the TXT record (for `txt` validation). */
  txtValue?: string;
  /** URL that must serve `httpBody` (for `http` validation). */
  httpUrl?: string;
  /** Body the `httpUrl` must respond with (for `http` validation). */
  httpBody?: string;
  /** Name of the CNAME record to create (for delegated DCV). */
  cname?: string;
  /** Target of the CNAME record (for delegated DCV). */
  cnameTarget?: string;
  /** Approver email addresses (for `email` validation). */
  emails?: string[];
  /** Validation status of this record. */
  status?: string;
}

export interface CertificatePackProps {
  /**
   * Zone the certificate pack belongs to. Stable — moving a pack to a
   * different zone triggers a replacement.
   */
  zoneId: string;
  /**
   * Certificate Authority to order the certificates from.
   *
   * Immutable — the Cloudflare API has no way to change the CA of an
   * existing pack, so changing it triggers a replacement.
   */
  certificateAuthority: CertificatePackCertificateAuthority;
  /**
   * Hostnames the certificates cover. Must contain the zone apex, may
   * contain wildcards, and may not exceed 50 hosts.
   *
   * Immutable — hosts cannot be added to or removed from an existing
   * pack, so changing them (order-insensitively) triggers a replacement.
   */
  hosts: string[];
  /**
   * Domain Control Validation method for the order.
   *
   * Mutable — changed in place on the existing pack via the SSL
   * verification API (`PATCH /ssl/verification/{certificatePackId}`).
   */
  validationMethod: CertificatePackValidationMethod;
  /**
   * Validity period of the issued certificates, in days.
   *
   * Immutable — changing it triggers a replacement (re-order).
   */
  validityDays: CertificatePackValidityDays;
  /**
   * Whether to add Cloudflare branding to the order: a subdomain of
   * `sni.cloudflaressl.com` is used as the certificate's Common Name.
   *
   * Mutable — patched in place.
   *
   * @default false
   */
  cloudflareBranding?: boolean;
}

export interface CertificatePackAttributes {
  /** Cloudflare-assigned identifier of the certificate pack. */
  certificatePackId: string;
  /** Zone the pack belongs to. */
  zoneId: string;
  /**
   * Current status of the pack. Issuance is asynchronous — a freshly
   * ordered pack starts in `initializing`/`pending_validation` and only
   * reaches `active` once Domain Control Validation completes.
   */
  status: CertificatePackStatus;
  /** Hostnames the certificates cover. */
  hosts: string[];
  /** Certificate Authority the pack was ordered from. */
  certificateAuthority: string;
  /** Domain Control Validation method currently configured. */
  validationMethod: string | undefined;
  /** Validity period of the issued certificates, in days. */
  validityDays: number | undefined;
  /** Identifier of the primary certificate in the pack, once issued. */
  primaryCertificate: string | undefined;
  /**
   * Outstanding Domain Control Validation records — create these
   * TXT/CNAME records (or serve the HTTP tokens) to complete validation.
   */
  validationRecords: CertificatePackValidationRecord[] | undefined;
  /** DCV Delegation records for delegated domain validation. */
  dcvDelegationRecords: CertificatePackValidationRecord[] | undefined;
}

export type CertificatePack = Resource<
  TypeId,
  CertificatePackProps,
  CertificatePackAttributes,
  never,
  Providers
>;

/**
 * An Advanced Certificate Manager (ACM) certificate pack — an order for
 * edge certificates covering a custom set of hostnames in a zone, with a
 * choice of Certificate Authority, validation method, and validity period.
 *
 * Requires the **Advanced Certificate Manager** subscription on the zone;
 * ordering without it fails with the typed `AdvancedCertificateManagerRequired`
 * error (Cloudflare code 1450).
 *
 * Issuance is asynchronous: the resource returns as soon as the order is
 * placed (status `initializing`/`pending_validation`) and does not wait for
 * `active`, because validation may require you to create DNS records first —
 * the outstanding records are exported as `validationRecords`.
 *
 * The pack's `certificateAuthority`, `hosts`, and `validityDays` are
 * immutable — changing any of them replaces the pack (a new order).
 * `validationMethod` and `cloudflareBranding` are updated in place.
 * @resource
 * @product SSL/TLS
 * @category SSL/TLS & Certificates
 * @section Ordering a certificate pack
 * @example Order an advanced certificate for the apex and a wildcard
 * ```typescript
 * const pack = yield* Cloudflare.Ssl.CertificatePack("ApexCert", {
 *   zoneId: zone.zoneId,
 *   certificateAuthority: "google",
 *   hosts: ["example.com", "*.example.com"],
 *   validationMethod: "txt",
 *   validityDays: 90,
 * });
 * ```
 *
 * @example Order from Let's Encrypt with a short validity
 * ```typescript
 * yield* Cloudflare.Ssl.CertificatePack("ShortLivedCert", {
 *   zoneId: zone.zoneId,
 *   certificateAuthority: "lets_encrypt",
 *   hosts: ["example.com", "api.example.com"],
 *   validationMethod: "http",
 *   validityDays: 30,
 * });
 * ```
 *
 * @section Completing validation
 * @example Create the DCV TXT records the order asks for
 * ```typescript
 * const pack = yield* Cloudflare.Ssl.CertificatePack("ApexCert", {
 *   zoneId: zone.zoneId,
 *   certificateAuthority: "google",
 *   hosts: ["example.com"],
 *   validationMethod: "txt",
 *   validityDays: 90,
 * });
 * // pack.validationRecords contains the txtName/txtValue pairs to create
 * // as DNS records so the CA can validate domain control.
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
 */
export const CertificatePack = Resource<CertificatePack>(TypeId);

/**
 * Returns true if the given value is a CertificatePack resource.
 */
export const isCertificatePack = (value: unknown): value is CertificatePack =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CertificatePackProvider = () =>
  Provider.succeed(CertificatePack, {
    stables: ["certificatePackId", "zoneId"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      // news is Input<Props> during plan — only compare once resolved.
      if (!isResolved(news)) return undefined;
      // No prior props to compare against — let the engine decide.
      if (olds?.hosts === undefined) return undefined;
      // zoneId is the pack's scope; it is Input<string>, so compare only
      // once both sides are concrete.
      const oldZoneId =
        output?.zoneId ??
        (typeof olds.zoneId === "string" ? olds.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof news.zoneId === "string" &&
        oldZoneId !== news.zoneId
      ) {
        return { action: "replace" } as const;
      }
      // The order is immutable in CA, hosts, and validity — any change is
      // a re-order (replacement). hosts compare order-insensitively.
      if (
        olds.certificateAuthority !== news.certificateAuthority ||
        olds.validityDays !== news.validityDays ||
        !sameHosts(olds.hosts, news.hosts)
      ) {
        return { action: "replace" } as const;
      }
      // validationMethod / cloudflareBranding are in-place updates.
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (!zoneId) return undefined;

      // Owned path: refresh by our persisted pack id.
      if (output?.certificatePackId) {
        const observed = yield* getPack(zoneId, output.certificatePackId);
        if (observed) return toAttributes(zoneId, observed);
        return undefined;
      }

      // Cold lookup (state persistence failed before we saved the id): an
      // advanced pack with this exact host set may already exist. Packs
      // carry no ownership markers, so report it as `Unowned` and let the
      // engine gate takeover behind the adopt policy.
      if (olds?.hosts) {
        const observed = yield* findByHosts(zoneId, olds.hosts);
        if (observed) return Unowned(toAttributes(zoneId, observed));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the pack id cached on `output` is a hint, not a
      //    guarantee: a missing pack falls through to the host-set scan
      //    and then to a fresh order.
      let observed = output?.certificatePackId
        ? yield* getPack(zoneId, output.certificatePackId)
        : undefined;

      // 2. Fall back to scanning the zone for an advanced pack with the
      //    same host set (recovers from a crash after order-before-save).
      if (!observed) {
        observed = yield* findByHosts(zoneId, news.hosts);
      }

      // 3. Ensure — order the pack when missing. Ordering is gated on the
      //    Advanced Certificate Manager subscription; the typed
      //    `AdvancedCertificateManagerRequired` error propagates to the
      //    caller untouched.
      if (!observed) {
        observed = yield* ssl.createCertificatePack({
          zoneId,
          type: "advanced",
          certificateAuthority: news.certificateAuthority,
          hosts: news.hosts,
          validationMethod: news.validationMethod,
          validityDays: news.validityDays,
          cloudflareBranding: news.cloudflareBranding,
        });
      }

      // 4. Sync — diff each mutable aspect of the observed pack against
      //    the desired props; skip the API entirely on a no-op. A freshly
      //    ordered pack already matches, so both checks fall through.
      if (
        news.cloudflareBranding !== undefined &&
        (observed.cloudflareBranding ?? false) !== news.cloudflareBranding
      ) {
        observed = yield* ssl.patchCertificatePack({
          zoneId,
          certificatePackId: observed.id,
          cloudflareBranding: news.cloudflareBranding,
        });
      }

      let validationMethod = observed.validationMethod ?? undefined;
      if (validationMethod !== news.validationMethod) {
        const verification = yield* ssl.patchVerification({
          zoneId,
          certificatePackId: observed.id,
          validationMethod: news.validationMethod,
        });
        validationMethod = verification.validationMethod ?? validationMethod;
      }

      return toAttributes(zoneId, observed, validationMethod);
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Certificate packs are zone-scoped; there is no account-wide
      // enumeration API. Fan out over every zone in the account and list
      // its packs, restricting to `advanced` packs (the only kind this
      // resource manages — universal/total_tls packs are not orderable).
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          ssl.listCertificatePacks
            .pages({ zoneId: zone.id, status: "all" })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? [])
                    .filter((pack) => pack.type === "advanced")
                    .map((pack) => toAttributes(zone.id, pack)),
                ),
              ),
              // A plan-gated zone (no ACM) rejects the route, and a freshly
              // minted token may briefly answer Forbidden — skip either.
              Effect.catchTag(["InvalidRoute", "Forbidden"], () =>
                Effect.succeed([] as CertificatePackAttributes[]),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    delete: Effect.fn(function* ({ output }) {
      // Observe first — deleting an already-gone pack answers 404 (code
      // 1408); treat missing as done so delete stays idempotent.
      const observed = yield* getPack(output.zoneId, output.certificatePackId);
      if (!observed) return;
      yield* ssl
        .deleteCertificatePack({
          zoneId: output.zoneId,
          certificatePackId: output.certificatePackId,
        })
        .pipe(Effect.catchTag("CertificatePackNotFound", () => Effect.void));
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type ObservedPack =
  | ssl.GetCertificatePackResponse
  | ssl.CreateCertificatePackResponse
  | ssl.PatchCertificatePackResponse
  | ssl.ListCertificatePacksResponse["result"][number];

/**
 * Read a pack by id, mapping "gone" (`CertificatePackNotFound`, Cloudflare
 * error code 1408 / HTTP 404) and a deleted zone (`InvalidRoute`, code
 * 7003) to `undefined`.
 */
const getPack = (zoneId: string, certificatePackId: string) =>
  ssl.getCertificatePack({ zoneId, certificatePackId }).pipe(
    Effect.map((pack): ssl.GetCertificatePackResponse | undefined => pack),
    Effect.catchTag(["CertificatePackNotFound", "InvalidRoute"], () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find an advanced pack by exact host set within the zone. Cloudflare
 * rejects a second advanced order for an identical host set, so at most
 * one pack can match. Includes non-active (pending) packs.
 */
const findByHosts = (zoneId: string, hosts: string[]) =>
  ssl.listCertificatePacks.items({ zoneId, status: "all" }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (pack) => pack.type === "advanced" && sameHosts(pack.hosts, hosts),
      ),
    ),
    Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
  );

/** Order-insensitive host set comparison. */
const sameHosts = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((host) => set.has(host));
};

const toRecord = (record: {
  cname?: string | null;
  cnameTarget?: string | null;
  emails?: string[] | null;
  httpBody?: string | null;
  httpUrl?: string | null;
  status?: string | null;
  txtName?: string | null;
  txtValue?: string | null;
}): CertificatePackValidationRecord => ({
  txtName: record.txtName ?? undefined,
  txtValue: record.txtValue ?? undefined,
  httpUrl: record.httpUrl ?? undefined,
  httpBody: record.httpBody ?? undefined,
  cname: record.cname ?? undefined,
  cnameTarget: record.cnameTarget ?? undefined,
  emails: record.emails ?? undefined,
  status: record.status ?? undefined,
});

const toAttributes = (
  zoneId: string,
  pack: ObservedPack,
  validationMethod?: string,
): CertificatePackAttributes => ({
  certificatePackId: pack.id,
  zoneId,
  status: pack.status as CertificatePackStatus,
  hosts: [...pack.hosts],
  certificateAuthority: pack.certificateAuthority ?? "",
  validationMethod: validationMethod ?? pack.validationMethod ?? undefined,
  validityDays: pack.validityDays ?? undefined,
  primaryCertificate: pack.primaryCertificate ?? undefined,
  validationRecords: pack.validationRecords?.map(toRecord) ?? undefined,
  dcvDelegationRecords: pack.dcvDelegationRecords?.map(toRecord) ?? undefined,
});
