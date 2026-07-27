import * as originTls from "@distilled.cloud/cloudflare/origin-tls-client-auth";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.OriginTlsClientAuth.Certificate" as const;
type TypeId = typeof TypeId;

/**
 * Deployment status of the certificate. Deploying and deleting are
 * asynchronous (`pending_deployment` → `active`, `pending_deletion` →
 * `deleted`), typically settling within minutes.
 */
export type CertificateStatus =
  | "initializing"
  | "pending_deployment"
  | "pending_deletion"
  | "active"
  | "deleted"
  | "deployment_timed_out"
  | "deletion_timed_out"
  // Keep the union open so new Cloudflare statuses aren't blocked by stale types.
  | (string & {});

export type CertificateProps = {
  /**
   * Zone the certificate is uploaded to. Cannot be changed after upload —
   * updating this property triggers a replacement.
   */
  zoneId: string;
  /**
   * The zone's leaf client certificate in PEM format, presented by
   * Cloudflare to your origin when Authenticated Origin Pulls is enabled.
   * Cannot be changed after upload — updating this property triggers a
   * replacement.
   */
  certificate: string;
  /**
   * The certificate's private key in PEM format. Cannot be changed after
   * upload — updating this property triggers a replacement.
   */
  privateKey: Redacted.Redacted<string>;
};

export type CertificateAttributes = {
  /** Unique identifier of the uploaded certificate. */
  certificateId: string;
  /** Zone the certificate is uploaded to. */
  zoneId: string;
  /** Deployment status of the certificate. */
  status: CertificateStatus | undefined;
  /** When the certificate expires. */
  expiresOn: string | undefined;
  /** The certificate authority that issued the certificate. */
  issuer: string | undefined;
  /** The type of hash used for the certificate signature. */
  signature: string | undefined;
  /** When the certificate was uploaded to Cloudflare. */
  uploadedOn: string | undefined;
};

export type Certificate = Resource<
  TypeId,
  CertificateProps,
  CertificateAttributes,
  never,
  Providers
>;

/**
 * A zone-level Authenticated Origin Pulls (AOP) client certificate
 * (`/zones/{zone_id}/origin_tls_client_auth`).
 *
 * Uploads the client certificate Cloudflare presents to your origin when
 * zone-level Authenticated Origin Pulls is enabled
 * ({@link Setting}), letting the origin verify that
 * requests really come from Cloudflare via mTLS.
 *
 * Certificates are immutable: there is no update API, so changing any
 * property triggers a replacement. Deployment is asynchronous — the
 * certificate starts in `pending_deployment` and becomes `active` within a
 * few minutes; deletion likewise passes through `pending_deletion`.
 * @resource
 * @product Origin TLS Client Auth
 * @category SSL/TLS & Certificates
 * @section Uploading a certificate
 * @example Zone client certificate
 * ```typescript
 * const cert = yield* Cloudflare.OriginTlsClientAuth.Certificate("AopCert", {
 *   zoneId: zone.zoneId,
 *   certificate: clientCertPem,
 *   privateKey: alchemy.secret.env.AOP_CLIENT_KEY,
 * });
 * ```
 *
 * @section Enabling Authenticated Origin Pulls
 * @example Upload the certificate and turn AOP on
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
 * @see https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/
 */
export const Certificate = Resource<Certificate>(TypeId);

/**
 * Returns true if the given value is an Certificate
 * resource.
 */
export const isCertificate = (value: unknown): value is Certificate =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: ["certificateId", "zoneId"],

    diff: Effect.fn(function* ({ olds = {}, news }) {
      if (!isResolved(news)) return undefined;
      const o = olds as CertificateProps;
      const n = news as CertificateProps;
      // zoneId is Input<string>; compare only once both sides are concrete.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      if (
        (o.certificate !== undefined &&
          normalizePem(o.certificate) !== normalizePem(n.certificate)) ||
        (o.privateKey !== undefined &&
          unwrap(o.privateKey) !== unwrap(n.privateKey))
      ) {
        // There is no update API for zone client certificates — every change
        // is a replacement.
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      if (output?.certificateId) {
        const observed = yield* observeById(zoneId, output.certificateId);
        if (observed) return toAttributes(observed, zoneId);
      }
      // Cold read — recover by listing and matching on the certificate PEM
      // content (the only identity available; zone client certificates have
      // no name or tags). A content match IS the desired state, so adoption
      // is safe without an `Unowned` gate.
      if (typeof olds?.certificate === "string") {
        const match = yield* findByContent(zoneId, olds.certificate);
        if (match) return toAttributes(match, zoneId);
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the certificate id is the stable identifier; fall
      //    through a CertificateNotFound (or a pending/completed deletion)
      //    to the list+content match so we recover from out-of-band deletes
      //    and partial state persistence.
      let observed = output?.certificateId
        ? yield* observeById(zoneId, output.certificateId)
        : yield* findByContent(zoneId, news.certificate);

      // 2. Ensure — upload if missing. Cloudflare rejects uploading a PEM
      //    identical to a live certificate (code 1406); tolerate the race
      //    (or an orphaned prior upload) by re-listing and adopting the
      //    certificate with identical PEM content. Re-uploading the PEM of
      //    a certificate in `pending_deletion` resurrects it under the same
      //    id, so a destroy→deploy cycle converges naturally.
      if (!observed) {
        observed = yield* originTls
          .createOriginTlsClientAuth({
            zoneId,
            certificate: news.certificate,
            privateKey: unwrap(news.privateKey),
          })
          .pipe(
            Effect.catchTag("CertificateAlreadyExists", (originalError) =>
              Effect.gen(function* () {
                const match = yield* findByContent(zoneId, news.certificate);
                if (!match) return yield* Effect.fail(originalError);
                return match;
              }),
            ),
            // A destroy→deploy cycle re-uploading the same PEM hits 1406 while
            // the prior certificate's tombstone is still `pending_deletion`
            // (it settles to `deleted` within ~10s, after which the same PEM
            // either resurrects under its old id or uploads fresh). Ride that
            // window out with a bounded retry of the whole create-or-adopt
            // step.
            //
            // Cloudflare serializes zone client-cert mutations per zone; when a
            // sibling upload/delete on the SAME zone is in flight, a concurrent
            // upload is rejected with HTTP 409 (`ZoneClientCertConflict`).
            // Retry it on the same bounded (~50s) schedule so concurrent
            // per-zone mutations serialize gracefully instead of failing the
            // deploy.
            Effect.retry({
              while: (e) =>
                e._tag === "CertificateAlreadyExists" ||
                e._tag === "ZoneClientCertConflict",
              schedule: Schedule.spaced("5 seconds"),
              times: 10,
            }),
          );
      }

      // 3. Return — deployment is asynchronous (`pending_deployment` →
      //    `active`); we do not block on activation.
      return toAttributes(observed, zoneId);
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          originTls.listOriginTlsClientAuths.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  // Match `read`: tombstoned (deleted / pending_deletion)
                  // certificates no longer satisfy the desired state.
                  .filter((cert) => isLive(cert.status))
                  .map((cert) => toAttributes(cert, zone.id)),
              ),
            ),
            // A zone the scoped token can't access rejects with the typed
            // Forbidden tag; skip it rather than failing the whole enumeration.
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deletion is idempotent: a certificate that is already gone surfaces
      // as `CertificateNotFound`, and one already in (or past) deletion
      // answers HTTP 400 "Certificate is already deleted."
      // (`CertificateAlreadyDeleted`). Both mean the desired end state — the
      // certificate is not live — is reached.
      yield* originTls
        .deleteOriginTlsClientAuth({
          zoneId: output.zoneId,
          certificateId: output.certificateId,
        })
        .pipe(
          // A certificate still propagating its initial deployment answers
          // code 1434 "Cannot delete resource while in pending deployment
          // state." — this is why a destroy immediately after a deploy could
          // leak the certificate. Deployment settles within seconds, so ride
          // it out with a bounded (~60s) retry.
          //
          // Cloudflare serializes zone client-cert mutations per zone; a delete
          // racing a sibling upload/delete on the SAME zone is rejected with
          // HTTP 409 (`ZoneClientCertConflict`). Retry it on the same bounded
          // schedule so the delete (and thus teardown) converges instead of
          // leaking the certificate.
          Effect.retry({
            while: (e) =>
              e._tag === "CertificatePendingDeployment" ||
              e._tag === "ZoneClientCertConflict",
            schedule: Schedule.spaced("5 seconds"),
            times: 12,
          }),
          Effect.catchTag(
            ["CertificateNotFound", "CertificateAlreadyDeleted"],
            () => Effect.void,
          ),
        );
    }),
  });

/** A certificate that is being or has been deleted no longer satisfies the desired state. */
const isLive = (status: string | null | undefined): boolean =>
  status !== "deleted" && status !== "pending_deletion";

// Observe a certificate by id, treating "not found" and "deleted /
// pending_deletion" (Cloudflare keeps tombstones readable by id) as missing.
const observeById = (zoneId: string, certificateId: string) =>
  originTls.getOriginTlsClientAuth({ zoneId, certificateId }).pipe(
    Effect.map((cert) => (isLive(cert.status) ? cert : undefined)),
    Effect.catchTag("CertificateNotFound", () => Effect.succeed(undefined)),
  );

// Locate a live certificate by exact PEM content. Tombstoned certificates
// are excluded so a destroy→deploy cycle re-creates (resurrects) instead of
// adopting a certificate that is on its way out.
const findByContent = (zoneId: string, certificate: string) =>
  Effect.gen(function* () {
    const list = yield* originTls.listOriginTlsClientAuths({ zoneId });
    // Cloudflare returns `result: null` (not `[]`) for a zone whose cert store
    // is empty — treat it as no matches.
    return (list.result ?? []).find(
      (c) =>
        isLive(c.status) &&
        normalizePem(c.certificate ?? "") === normalizePem(certificate),
    );
  });

const normalizePem = (pem: string): string => pem.trim();

const unwrap = (value: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

type CertificateShape = {
  id?: string | null;
  status?: string | null;
  expiresOn?: string | null;
  issuer?: string | null;
  signature?: string | null;
  uploadedOn?: string | null;
};

const toAttributes = (
  cert: CertificateShape,
  zoneId: string,
): CertificateAttributes => ({
  certificateId: cert.id!,
  zoneId,
  status: cert.status ?? undefined,
  expiresOn: cert.expiresOn ?? undefined,
  issuer: cert.issuer ?? undefined,
  signature: cert.signature ?? undefined,
  uploadedOn: cert.uploadedOn ?? undefined,
});
