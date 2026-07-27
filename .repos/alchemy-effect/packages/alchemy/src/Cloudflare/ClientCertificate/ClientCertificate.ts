import * as clientCertificates from "@distilled.cloud/cloudflare/client-certificates";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.ClientCertificate.ClientCertificate" as const;
type TypeId = typeof TypeId;

/**
 * Lifecycle status of a client certificate. `pending_reactivation` and
 * `pending_revocation` are in-progress asynchronous transitions.
 */
export type Status =
  | "active"
  | "pending_reactivation"
  | "pending_revocation"
  | "revoked"
  // Keep the union open so new Cloudflare statuses aren't blocked by stale
  // types.
  | (string & {});

export interface Props {
  /**
   * Zone the client certificate is issued under. Client certificates are a
   * zone-level API Shield feature.
   *
   * Immutable — moving a certificate between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * The Certificate Signing Request (CSR) in PEM format. Must be
   * newline-encoded. Cloudflare's Managed CA signs this CSR and returns the
   * client certificate.
   *
   * Immutable — the API has no way to re-sign a certificate, so changing the
   * CSR triggers a replacement. Plain `string` (not `string`) so it is
   * statically comparable inside `diff`.
   */
  csr: string;
  /**
   * The number of days the client certificate will be valid after the
   * `issuedOn` date.
   *
   * Immutable — changing the validity triggers a replacement.
   */
  validityDays: number;
}

export interface Attributes {
  /** Cloudflare-assigned identifier of the client certificate. */
  clientCertificateId: string;
  /** Zone the certificate was issued under. */
  zoneId: string;
  /** The signed client certificate in PEM format. */
  certificate: string;
  /** The CSR the certificate was issued from, as echoed by Cloudflare. */
  csr: string;
  /** Common Name parsed from the CSR. */
  commonName: string | undefined;
  /** Country parsed from the CSR. */
  country: string | undefined;
  /** State parsed from the CSR. */
  state: string | undefined;
  /** Location parsed from the CSR. */
  location: string | undefined;
  /** Organization parsed from the CSR. */
  organization: string | undefined;
  /** Organizational Unit parsed from the CSR. */
  organizationalUnit: string | undefined;
  /** ISO8601 date the certificate expires. */
  expiresOn: string | undefined;
  /** ISO8601 date the certificate was issued by the Managed CA. */
  issuedOn: string | undefined;
  /** SHA-256 fingerprint of the certificate. */
  fingerprintSha256: string | undefined;
  /** The serial number on the issued certificate. */
  serialNumber: string | undefined;
  /** The type of hash used for the certificate signature. */
  signature: string | undefined;
  /** Subject Key Identifier. */
  ski: string | undefined;
  /** Current lifecycle status of the certificate. */
  status: Status;
  /** The number of days the certificate is valid after `issuedOn`. */
  validityDays: number;
  /** Identifier of the Certificate Authority that issued the certificate. */
  certificateAuthorityId: string | undefined;
  /** Name of the Certificate Authority that issued the certificate. */
  certificateAuthorityName: string | undefined;
}

export type ClientCertificate = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * A zone-level API Shield mTLS client certificate signed by the Cloudflare
 * Managed CA.
 *
 * You submit a Certificate Signing Request (CSR) plus a validity period;
 * Cloudflare signs it and returns the client certificate PEM, which clients
 * then present when connecting to API Shield mTLS-protected hostnames.
 *
 * Client certificates are immutable: there is no API to change the CSR or
 * validity, so any prop change triggers a replacement. Deleting the resource
 * revokes the certificate — revoked certificates remain listed on the zone in
 * `revoked` status but are treated as deleted by this resource.
 *
 * Safety: client certificates carry no ownership markers. When there is no
 * prior state, `read` scans the zone for a non-revoked certificate issued
 * from the same CSR and reports it as `Unowned`, so the engine refuses to
 * take it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Client Certificates
 * @category SSL/TLS & Certificates
 * @section Issuing a client certificate
 * @example Sign a CSR with the Cloudflare Managed CA
 * ```typescript
 * const cert = yield* Cloudflare.ClientCertificate.ClientCertificate("ApiClient", {
 *   zoneId: zone.zoneId,
 *   csr: clientCsrPem,
 *   validityDays: 365,
 * });
 * // cert.certificate is the signed client certificate PEM
 * ```
 *
 * @example Read the CSR from disk
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const csr = yield* fs.readFileString("certs/client.csr");
 *
 * const cert = yield* Cloudflare.ClientCertificate.ClientCertificate("ApiClient", {
 *   zoneId: zone.zoneId,
 *   csr,
 *   validityDays: 90,
 * });
 * ```
 *
 * @section Rotation
 * @example Rotate by changing the CSR
 * ```typescript
 * // csr and validityDays are immutable — changing either replaces the
 * // certificate: a new one is signed and the old one is revoked.
 * const cert = yield* Cloudflare.ClientCertificate.ClientCertificate("ApiClient", {
 *   zoneId: zone.zoneId,
 *   csr: rotatedCsrPem,
 *   validityDays: 365,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/client-certificates/
 */
export const ClientCertificate = Resource<ClientCertificate>(TypeId, {
  aliases: ["Cloudflare.ClientCertificate"],
});

/**
 * Returns true if the given value is a ClientCertificate resource.
 */
export const isClientCertificate = (
  value: unknown,
): value is ClientCertificate =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ClientCertificateProvider = () =>
  Provider.succeed(ClientCertificate, {
    // Everything Cloudflare returns at issuance is fixed for the lifetime of
    // the certificate — only `status` changes (revocation/reactivation).
    stables: [
      "clientCertificateId",
      "zoneId",
      "certificate",
      "csr",
      "commonName",
      "country",
      "state",
      "location",
      "organization",
      "organizationalUnit",
      "expiresOn",
      "issuedOn",
      "fingerprintSha256",
      "serialNumber",
      "signature",
      "ski",
      "validityDays",
      "certificateAuthorityId",
      "certificateAuthorityName",
    ],

    // Client certificates are a zone-scoped API Shield feature. Fan out over
    // every zone in the account, exhaustively paginate each zone's
    // certificates, and hydrate each into the same Attributes shape `read`
    // produces. Revoked certificates stay listed forever but revocation is the
    // delete semantic, so they are filtered out. Zones where API Shield is not
    // entitled reject with the typed `Forbidden` error — skip them.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          clientCertificates.listClientCertificates
            .pages({ zoneId: zone.id, status: "all" })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? [])
                    .filter((cert) => !isGone(cert.status))
                    .map((cert): Attributes => toAttributes(cert, zone.id)),
                ),
              ),
              Effect.catchTag("Forbidden", () => Effect.succeed([])),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as Props;
      const n = news as Props;
      // No prior props to compare against — let the engine decide.
      if (o.csr === undefined) return undefined;
      // The API has no update for csr/validityDays — every change replaces.
      if (normalizePem(o.csr) !== normalizePem(n.csr)) {
        return { action: "replace" } as const;
      }
      if (o.validityDays !== n.validityDays) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; compare only once both are concrete.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (zoneId === undefined) return undefined;

      // Owned path: refresh by our persisted certificate id. A revoked (or
      // asynchronously revoking) certificate stays listed on the zone forever
      // — revocation is the delete semantic, so report it as gone.
      if (output?.clientCertificateId) {
        const observed = yield* getCertificate(
          zoneId,
          output.clientCertificateId,
        );
        if (observed && !isGone(observed.status)) {
          return toAttributes(observed, zoneId);
        }
        return undefined;
      }

      // Adoption path: a non-revoked certificate issued from the same CSR
      // (with the same validity) may already exist on the zone. Client
      // certificates carry no ownership markers, so we cannot prove we
      // created it — brand it `Unowned` so the engine refuses takeover
      // unless `adopt` is set.
      if (olds?.csr !== undefined && olds.validityDays !== undefined) {
        const observed = yield* findByCsr(zoneId, olds.csr, olds.validityDays);
        if (observed) return Unowned(toAttributes(observed, zoneId));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the certificate id cached on `output` is a hint, not a
      //    guarantee. A missing or revoked certificate (revocation is the
      //    delete semantic; the certificate cannot serve mTLS) falls
      //    through to the CSR scan and then to create.
      let observed = output?.clientCertificateId
        ? yield* getCertificate(zoneId, output.clientCertificateId)
        : undefined;
      if (observed && isGone(observed.status)) observed = undefined;

      // 2. Fall back to scanning the zone for a non-revoked certificate
      //    issued from the same CSR with the same validity. Matching on
      //    BOTH props matters: a replacement keeps one of them while
      //    changing the other, so the old certificate never matches the new
      //    desired state and cannot be mistaken for it. Ownership has
      //    already been verified upstream — `read` reports existing
      //    certificates as `Unowned` and the engine gates takeover behind
      //    the adopt policy before reconcile ever runs.
      if (!observed) {
        observed = yield* findByCsr(zoneId, news.csr, news.validityDays);
      }

      // 3. Ensure — sign the CSR when missing. Cloudflare happily signs the
      //    same CSR multiple times (each issuance is a distinct
      //    certificate), so there is no AlreadyExists race to tolerate.
      if (!observed) {
        observed = yield* clientCertificates.createClientCertificate({
          zoneId,
          csr: news.csr,
          validityDays: news.validityDays,
        });
      }

      // 4. There is no sync step: csr/validityDays are immutable and every
      //    other attribute is derived at issuance.
      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // DELETE revokes the certificate. Revoked certificates remain listed
      // on the zone — observe first and treat already-revoked (or already
      // revoking) as done so delete is idempotent.
      const observed = yield* getCertificate(
        output.zoneId,
        output.clientCertificateId,
      );
      if (!observed || isGone(observed.status)) {
        return;
      }
      yield* clientCertificates
        .deleteClientCertificate({
          zoneId: output.zoneId,
          clientCertificateId: output.clientCertificateId,
        })
        .pipe(
          // Races with an out-of-band revoke/delete are convergence, not
          // failure.
          Effect.catchTag("ClientCertificateNotFound", () => Effect.void),
          Effect.catchTag("ClientCertificateAlreadyRevoked", () => Effect.void),
        );
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type ObservedCertificate = clientCertificates.GetClientCertificateResponse;

/**
 * Read a certificate by id, mapping "gone" (`ClientCertificateNotFound`,
 * Cloudflare error code 1415 `Invalid Certificate ID in request`) to
 * `undefined`.
 */
const getCertificate = (zoneId: string, clientCertificateId: string) =>
  clientCertificates.getClientCertificate({ zoneId, clientCertificateId }).pipe(
    Effect.map((cert): ObservedCertificate | undefined => cert),
    Effect.catchTag("ClientCertificateNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find a non-revoked certificate issued from the given CSR with the given
 * validity. Cloudflare echoes the CSR back on every certificate, so an exact
 * (whitespace-normalized) CSR + validity match is the only identity available
 * for cold reads — certificates have no names or tags. Both props are matched
 * so a replacement (which changes at least one of them) can never mistake the
 * outgoing certificate for the desired one.
 */
const findByCsr = (zoneId: string, csr: string, validityDays: number) =>
  clientCertificates.listClientCertificates
    .items({ zoneId, status: "all" })
    .pipe(
      Stream.filter(
        (cert) =>
          !isGone(cert.status) &&
          cert.validityDays === validityDays &&
          typeof cert.csr === "string" &&
          normalizePem(cert.csr) === normalizePem(csr),
      ),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      Effect.map((cert): ObservedCertificate | undefined => cert),
    );

/**
 * A certificate is "gone" once it is `revoked` or asynchronously transitioning
 * to it (`pending_revocation`). Revocation is the delete semantic, and a
 * revoking certificate can no longer serve mTLS — so it must never be adopted,
 * reused, listed, or treated as live. Without this, a prior run's async revoke
 * leaves a `pending_revocation` certificate that a fresh deploy would otherwise
 * mistake for an existing live certificate matching the CSR.
 */
const isGone = (status: string | null | undefined): boolean =>
  status === "revoked" || status === "pending_revocation";

/** Normalize PEM content for comparison (CRLF + trailing-newline noise). */
const normalizePem = (pem: string | undefined): string | undefined =>
  pem?.replace(/\r\n/g, "\n").trim();

const toAttributes = (
  cert: ObservedCertificate,
  zoneId: string,
): Attributes => ({
  clientCertificateId: cert.id!,
  zoneId,
  certificate: cert.certificate ?? "",
  csr: cert.csr ?? "",
  commonName: cert.commonName ?? undefined,
  country: cert.country ?? undefined,
  state: cert.state ?? undefined,
  location: cert.location ?? undefined,
  organization: cert.organization ?? undefined,
  organizationalUnit: cert.organizationalUnit ?? undefined,
  expiresOn: cert.expiresOn ?? undefined,
  issuedOn: cert.issuedOn ?? undefined,
  fingerprintSha256: cert.fingerprintSha256 ?? undefined,
  serialNumber: cert.serialNumber ?? undefined,
  signature: cert.signature ?? undefined,
  ski: cert.ski ?? undefined,
  status: (cert.status ?? "active") as Status,
  validityDays: cert.validityDays ?? 0,
  certificateAuthorityId: cert.certificateAuthority?.id ?? undefined,
  certificateAuthorityName: cert.certificateAuthority?.name ?? undefined,
});
