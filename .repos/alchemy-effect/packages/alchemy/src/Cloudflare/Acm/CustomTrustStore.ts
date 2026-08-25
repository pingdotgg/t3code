import * as acm from "@distilled.cloud/cloudflare/acm";
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

const TypeId = "Cloudflare.Acm.CustomTrustStore" as const;
type TypeId = typeof TypeId;

/**
 * Lifecycle status of an uploaded custom trust store certificate.
 * Upload is asynchronous: certificates start `initializing` and progress
 * to `active`; deletes go through `pending_deletion` before `deleted`.
 */
export type CustomTrustStoreStatus =
  | "initializing"
  | "pending_deployment"
  | "active"
  | "pending_deletion"
  | "deleted"
  | "expired"
  | (string & {});

export interface CustomTrustStoreProps {
  /**
   * Zone the trust store certificate belongs to.
   *
   * Immutable — moving the certificate to another zone triggers a
   * replacement.
   */
  zoneId: string;
  /**
   * The root CA certificate in PEM format. Only root CA certificates are
   * accepted; intermediate and leaf certificates are rejected by
   * Cloudflare.
   *
   * Immutable — the API has no update operation, so changing the
   * certificate triggers a replacement.
   */
  certificate: string;
}

export interface CustomTrustStoreAttributes {
  /** Cloudflare-assigned identifier of the trust store certificate. */
  id: string;
  /** Zone the certificate belongs to. */
  zoneId: string;
  /** The root CA certificate in PEM format, as echoed by Cloudflare. */
  certificate: string;
  /** When the certificate expires. */
  expiresOn: string;
  /** The certificate authority that issued the certificate. */
  issuer: string;
  /** The type of hash used for the certificate. */
  signature: string;
  /** Deployment status of the certificate. */
  status: CustomTrustStoreStatus;
  /** When the certificate was uploaded to Cloudflare. */
  uploadedOn: string;
  /** When the certificate was last modified. */
  updatedAt: string;
}

export type CustomTrustStore = Resource<
  TypeId,
  CustomTrustStoreProps,
  CustomTrustStoreAttributes,
  never,
  Providers
>;

/**
 * A root CA certificate in a zone's custom origin trust store
 * (`/zones/{zone_id}/acm/custom_trust_store`). Cloudflare uses the trust
 * store to validate your origin server's certificate when connecting to
 * the origin (e.g. with Full (strict) SSL and a private CA at the origin).
 *
 * Requires the Advanced Certificate Manager entitlement on the zone —
 * without it every call fails with the typed
 * `AdvancedCertificateManagerRequired` (code 1450) error.
 *
 * The certificate is immutable: there is no update API, so changing the
 * PEM (or the zone) replaces the resource. Trust store certificates carry
 * no ownership markers, so a cold `read` scans the zone for a certificate
 * with the same PEM body and reports it as `Unowned` — the engine refuses
 * to take it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product ACM
 * @category SSL/TLS & Certificates
 * @section Uploading a root CA
 * @example Trust a private root CA for origin pulls
 * ```typescript
 * const trustStore = yield* Cloudflare.Acm.CustomTrustStore("OriginRootCa", {
 *   zoneId: zone.zoneId,
 *   certificate: rootCaPem, // "-----BEGIN CERTIFICATE-----\n..."
 * });
 * ```
 *
 * @example Load the PEM from a file
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const pem = yield* fs.readFileString("./certs/root-ca.pem");
 * yield* Cloudflare.Acm.CustomTrustStore("OriginRootCa", {
 *   zoneId: zone.zoneId,
 *   certificate: pem,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api/resources/acm/
 */
export const CustomTrustStore = Resource<CustomTrustStore>(TypeId);

/**
 * Returns true if the given value is a CustomTrustStore resource.
 */
export const isCustomTrustStore = (value: unknown): value is CustomTrustStore =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CustomTrustStoreProvider = () =>
  Provider.succeed(CustomTrustStore, {
    stables: ["id", "zoneId", "issuer", "signature", "uploadedOn"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Trust stores live inside a zone (`/zones/{zone_id}/acm/...`) with
      // no account-wide collection API — enumerate every zone and list
      // within each, paginating exhaustively.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          acm.listCustomTrustStores.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  .filter((cert) => !isGoneStatus(cert.status))
                  .map((cert) => toAttributes(zone.id, cert)),
              ),
            ),
            // Zones without the Advanced Certificate Manager add-on reject
            // the route with the typed entitlement tag — skip them.
            Effect.catchTag("AdvancedCertificateManagerRequired", () =>
              Effect.succeed([] as CustomTrustStoreAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The certificate is the resource's identity — no update API exists.
      const oldCertificate = olds?.certificate ?? output?.certificate;
      if (
        oldCertificate !== undefined &&
        normalizePem(oldCertificate) !== normalizePem(news.certificate)
      ) {
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
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;

      // Owned path: refresh by our persisted certificate id.
      if (output?.id) {
        const observed = yield* getTrustStore(zoneId, output.id);
        if (observed && !isGoneStatus(observed.status)) {
          return toAttributes(zoneId, observed);
        }
      }

      // Adoption path: a certificate with the same PEM may already exist.
      // Trust store entries carry no ownership markers, so report it as
      // `Unowned` and let the engine gate takeover behind the adopt policy.
      const certificate = output?.certificate ?? olds?.certificate;
      if (certificate) {
        const observed = yield* findByCertificate(zoneId, certificate);
        if (observed) return Unowned(toAttributes(zoneId, observed));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the id cached on `output` is a hint, not a guarantee:
      //    a missing (or async-deleted) certificate falls through to the
      //    PEM scan and then to create.
      let observed = output?.id
        ? yield* getTrustStore(zoneId, output.id)
        : undefined;
      if (observed && isGoneStatus(observed.status)) observed = undefined;

      // 2. Fall back to scanning the zone for the same PEM body. Ownership
      //    has already been verified upstream — `read` reports foreign
      //    certificates as `Unowned` and the engine gates adoption.
      if (!observed) {
        observed = yield* findByCertificate(zoneId, news.certificate);
      }

      // 3. Ensure — upload when missing. There is no sync step: the
      //    certificate is immutable (diff replaces on any change).
      if (!observed) {
        observed = yield* acm.createCustomTrustStore({
          zoneId,
          certificate: news.certificate,
        });
      }

      return toAttributes(zoneId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Observe first — re-deleting an already-gone certificate is a no-op
      // (delete must stay idempotent across crashed runs).
      const observed = yield* getTrustStore(output.zoneId, output.id);
      if (!observed || isGoneStatus(observed.status)) return;
      yield* acm
        .deleteCustomTrustStore({
          zoneId: output.zoneId,
          customOriginTrustStoreId: output.id,
        })
        .pipe(
          Effect.catchTag(
            ["CustomTrustStoreNotFound", "InvalidObjectIdentifier"],
            () => Effect.void,
          ),
        );
    }),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ObservedTrustStore =
  | acm.GetCustomTrustStoreResponse
  | acm.CreateCustomTrustStoreResponse
  | acm.ListCustomTrustStoresResponse["result"][number];

/**
 * Deletion is asynchronous — a certificate lingers in `pending_deletion`
 * (then `deleted`) after a successful DELETE. Treat both as "gone" so
 * observation does not resurrect a dying certificate.
 */
const isGoneStatus = (status: CustomTrustStoreStatus): boolean =>
  status === "pending_deletion" || status === "deleted";

/**
 * Read a trust store certificate by id, mapping "gone"
 * (`CustomTrustStoreNotFound` / `InvalidObjectIdentifier`) to `undefined`.
 */
const getTrustStore = (zoneId: string, id: string) =>
  acm.getCustomTrustStore({ zoneId, customOriginTrustStoreId: id }).pipe(
    Effect.map((cert): ObservedTrustStore | undefined => cert),
    Effect.catchTag(
      ["CustomTrustStoreNotFound", "InvalidObjectIdentifier"],
      () => Effect.succeed(undefined),
    ),
  );

/**
 * Find a live certificate with the same PEM body in the zone's trust
 * store. PEMs are compared after whitespace normalization so formatting
 * differences (trailing newline, CRLF) don't defeat the match.
 */
const findByCertificate = (zoneId: string, certificate: string) =>
  acm.listCustomTrustStores.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (cert): cert is ObservedTrustStore =>
          !isGoneStatus(cert.status) &&
          normalizePem(cert.certificate) === normalizePem(certificate),
      ),
    ),
  );

const normalizePem = (pem: string): string => pem.replace(/\r\n/g, "\n").trim();

const toAttributes = (
  zoneId: string,
  cert: ObservedTrustStore,
): CustomTrustStoreAttributes => ({
  id: cert.id,
  zoneId,
  certificate: cert.certificate,
  expiresOn: cert.expiresOn,
  issuer: cert.issuer,
  signature: cert.signature,
  status: cert.status,
  uploadedOn: cert.uploadedOn,
  updatedAt: cert.updatedAt,
});
