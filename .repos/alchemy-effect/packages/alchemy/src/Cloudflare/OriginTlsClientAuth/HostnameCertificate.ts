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

const TypeId = "Cloudflare.OriginTlsClientAuth.HostnameCertificate" as const;
type TypeId = typeof TypeId;

/**
 * Deployment status of the certificate. Deploying and deleting are
 * asynchronous (`pending_deployment` → `active`, `pending_deletion` →
 * `deleted`), typically settling within minutes.
 */
export type HostnameCertificateStatus =
  | "initializing"
  | "pending_deployment"
  | "pending_deletion"
  | "active"
  | "deleted"
  | "deployment_timed_out"
  | "deletion_timed_out"
  // Keep the union open so new Cloudflare statuses aren't blocked by stale types.
  | (string & {});

export type HostnameCertificateProps = {
  /**
   * Zone the certificate is uploaded to. Cannot be changed after upload —
   * updating this property triggers a replacement.
   */
  zoneId: string;
  /**
   * The per-hostname client certificate in PEM format, presented by
   * Cloudflare to your origin for hostnames associated with it via
   * {@link HostnameAssociation}. Cannot be changed after
   * upload — updating this property triggers a replacement.
   */
  certificate: string;
  /**
   * The certificate's private key in PEM format. Cannot be changed after
   * upload — updating this property triggers a replacement.
   */
  privateKey: Redacted.Redacted<string>;
};

export type HostnameCertificateAttributes = {
  /** Unique identifier of the uploaded certificate. */
  certificateId: string;
  /** Zone the certificate is uploaded to. */
  zoneId: string;
  /** Deployment status of the certificate. */
  status: HostnameCertificateStatus | undefined;
  /** When the certificate expires. */
  expiresOn: string | undefined;
  /** The certificate authority that issued the certificate. */
  issuer: string | undefined;
  /** The serial number on the uploaded certificate. */
  serialNumber: string | undefined;
  /** The type of hash used for the certificate signature. */
  signature: string | undefined;
  /** When the certificate was uploaded to Cloudflare. */
  uploadedOn: string | undefined;
};

export type HostnameCertificate = Resource<
  TypeId,
  HostnameCertificateProps,
  HostnameCertificateAttributes,
  never,
  Providers
>;

/**
 * A per-hostname Authenticated Origin Pulls (AOP) client certificate
 * (`/zones/{zone_id}/origin_tls_client_auth/hostnames/certificates`).
 *
 * Uploads a client certificate that Cloudflare presents to your origin for
 * specific hostnames. Hostnames opt in by referencing the certificate from an
 * {@link HostnameAssociation}, which pins the certificate
 * and enables hostname-level AOP.
 *
 * Certificates are immutable: there is no update API, so changing any
 * property triggers a replacement. Deployment is asynchronous — the
 * certificate starts in `pending_deployment` and becomes `active` within a
 * few minutes; deletion likewise passes through `pending_deletion`.
 * @resource
 * @product Origin TLS Client Auth
 * @category SSL/TLS & Certificates
 * @section Uploading a hostname certificate
 * @example Hostname client certificate
 * ```typescript
 * const cert = yield* Cloudflare.OriginTlsClientAuth.HostnameCertificate("AopHostCert", {
 *   zoneId: zone.zoneId,
 *   certificate: clientCertPem,
 *   privateKey: alchemy.secret.env.AOP_CLIENT_KEY,
 * });
 * ```
 *
 * @section Enabling AOP for a hostname
 * @example Upload the certificate and associate a hostname
 * ```typescript
 * const cert = yield* Cloudflare.OriginTlsClientAuth.HostnameCertificate("AopHostCert", {
 *   zoneId: zone.zoneId,
 *   certificate: clientCertPem,
 *   privateKey: alchemy.secret.env.AOP_CLIENT_KEY,
 * });
 *
 * yield* Cloudflare.OriginTlsClientAuth.HostnameAssociation("AopHost", {
 *   zoneId: zone.zoneId,
 *   hostname: "api.example.com",
 *   certId: cert.certificateId,
 *   enabled: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/per-hostname/
 */
export const HostnameCertificate = Resource<HostnameCertificate>(TypeId);

/**
 * Returns true if the given value is an HostnameCertificate
 * resource.
 */
export const isHostnameCertificate = (
  value: unknown,
): value is HostnameCertificate =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const HostnameCertificateProvider = () =>
  Provider.succeed(HostnameCertificate, {
    stables: ["certificateId", "zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Per-hostname client certificates live inside a zone and are only
      // enumerable per-zone — fan out over every zone in the account.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          originTls.listHostnameCertificates.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  // Match `read`: tombstoned (deleted / pending_deletion)
                  // certificates no longer satisfy the desired state.
                  .filter((c) => isLive(c.status))
                  .map((c) => toAttributes(c, zone.id)),
              ),
            ),
            // Plan-gated / partial zones reject the route; skip them.
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // zoneId is Input<string>; compare only once both sides are concrete.
      if (
        typeof olds.zoneId === "string" &&
        typeof news.zoneId === "string" &&
        olds.zoneId !== news.zoneId
      ) {
        return { action: "replace" } as const;
      }
      // Compare the certificate only when the old value is known — an
      // Output-valued `certificate` doesn't survive a `creating`-state
      // round-trip (it deserializes as `undefined`).
      if (
        (olds.certificate !== undefined &&
          normalizePem(olds.certificate) !== normalizePem(news.certificate)) ||
        unwrap(olds.privateKey) !== unwrap(news.privateKey)
      ) {
        // There is no update API for hostname client certificates — every
        // change is a replacement.
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
      // content (the only identity available; hostname client certificates
      // have no name or tags). A content match IS the desired state, so
      // adoption is safe without an `Unowned` gate.
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
      //    through a HostnameCertificateNotFound (or a pending/completed
      //    deletion) to the list+content match so we recover from
      //    out-of-band deletes and partial state persistence.
      let observed = output?.certificateId
        ? yield* observeById(zoneId, output.certificateId)
        : yield* findByContent(zoneId, news.certificate);

      // 2. Ensure — upload if missing. Cloudflare rejects uploading a PEM
      //    identical to an existing certificate (code 1406); tolerate the
      //    race (or an orphaned prior upload) by re-listing and adopting the
      //    certificate with identical PEM content. A destroy→deploy cycle
      //    also hits 1406 while the old certificate's tombstone is still
      //    `pending_deletion` (observed live: it settles to `deleted` within
      //    ~10 seconds, after which re-uploading the PEM resurrects it under
      //    the same id) — ride that window out with a bounded retry of the
      //    whole create-or-adopt step.
      if (!observed) {
        observed = yield* originTls
          .createHostnameCertificate({
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
            Effect.retry({
              while: (e) => e._tag === "CertificateAlreadyExists",
              schedule: Schedule.spaced("5 seconds"),
              times: 10,
            }),
          );
      }

      // 3. Return — deployment is asynchronous (`pending_deployment` →
      //    `active`); we do not block on activation.
      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* originTls
        .deleteHostnameCertificate({
          zoneId: output.zoneId,
          certificateId: output.certificateId,
        })
        .pipe(
          // The certificate cannot be deleted while a hostname association
          // still references it (code 1433) or while its initial deployment
          // is still propagating (code 1434). Both clear within seconds once
          // the association is voided / the deployment lands — ride them out
          // with a bounded retry.
          Effect.retry({
            while: (e) =>
              e._tag === "HostnameCertificateInUse" ||
              e._tag === "CertificatePendingDeployment",
            schedule: Schedule.spaced("5 seconds"),
            times: 10,
          }),
          // Already gone (404 / code 1551) or already on its way out
          // (code 1414 pending deletion) — delete is idempotent.
          Effect.catchTag(
            ["HostnameCertificateNotFound", "CertificatePendingDeletion"],
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
  originTls.getHostnameCertificate({ zoneId, certificateId }).pipe(
    Effect.map((cert) => (isLive(cert.status) ? cert : undefined)),
    Effect.catchTag("HostnameCertificateNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

// Locate a live certificate by exact PEM content. Tombstoned certificates
// are excluded so a destroy→deploy cycle re-creates (resurrects) instead of
// adopting a certificate that is on its way out.
const findByContent = (zoneId: string, certificate: string) =>
  Effect.gen(function* () {
    const list = yield* originTls.listHostnameCertificates({ zoneId });
    return list.result.find(
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
  serialNumber?: string | null;
  signature?: string | null;
  uploadedOn?: string | null;
};

const toAttributes = (
  cert: CertificateShape,
  zoneId: string,
): HostnameCertificateAttributes => ({
  certificateId: cert.id!,
  zoneId,
  status: cert.status ?? undefined,
  expiresOn: cert.expiresOn ?? undefined,
  issuer: cert.issuer ?? undefined,
  serialNumber: cert.serialNumber ?? undefined,
  signature: cert.signature ?? undefined,
  uploadedOn: cert.uploadedOn ?? undefined,
});
