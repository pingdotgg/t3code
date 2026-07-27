import * as originCa from "@distilled.cloud/cloudflare/origin-ca-certificates";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { findZoneByName, listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.OriginCaCertificate.OriginCaCertificate" as const;
type TypeId = typeof TypeId;

/**
 * Signature type requested on the certificate: `origin-rsa` (RSA),
 * `origin-ecc` (ECDSA), or `keyless-certificate` (for Keyless SSL servers).
 */
export type RequestType = "origin-rsa" | "origin-ecc" | "keyless-certificate";

/**
 * Number of days the certificate should be valid for. Cloudflare only
 * accepts this fixed set of validity periods.
 */
export type Validity = 7 | 30 | 90 | 365 | 730 | 1095 | 5475;

export interface Props {
  /**
   * The Certificate Signing Request (CSR) in PEM format (newline-encoded).
   * The CSR's key is yours; Cloudflare only signs it. Immutable — changing
   * the CSR triggers a replacement (a new certificate is issued and the old
   * one is revoked).
   */
  csr: string;
  /**
   * Hostnames or wildcard names (e.g. `*.example.com`) bound to the
   * certificate. Hostnames must be fully qualified domain names belonging
   * to zones on your account. Immutable — changing the hostnames triggers
   * a replacement.
   */
  hostnames: string[];
  /**
   * Signature type desired on the certificate: `origin-rsa` (RSA),
   * `origin-ecc` (ECDSA), or `keyless-certificate` (for Keyless SSL
   * servers). Immutable — changing the request type triggers a replacement.
   */
  requestType: RequestType;
  /**
   * The number of days for which the certificate should be valid.
   * Immutable — changing the validity triggers a replacement.
   * @default 5475
   */
  requestedValidity?: Validity;
}

export interface Attributes {
  /**
   * Cloudflare-assigned identifier of the certificate (a long decimal
   * serial string). Stable for the lifetime of the certificate.
   */
  certificateId: string;
  /**
   * The signed Origin CA certificate in PEM format (newline-encoded).
   * Install this on your origin server alongside the private key that
   * produced the CSR.
   */
  certificate: string;
  /**
   * The Certificate Signing Request the certificate was issued for.
   */
  csr: string;
  /**
   * Hostnames or wildcard names bound to the certificate.
   */
  hostnames: string[];
  /**
   * Signature type on the certificate.
   */
  requestType: RequestType;
  /**
   * The number of days the certificate was requested to be valid for.
   */
  requestedValidity: number;
  /**
   * When the certificate expires.
   */
  expiresOn: string | undefined;
}

export type OriginCaCertificate = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * A Cloudflare Origin CA certificate — a free certificate signed by
 * Cloudflare's Origin CA that encrypts traffic between Cloudflare's edge
 * and your origin server. Origin CA certificates are only trusted by
 * Cloudflare (not by browsers), so they are used together with proxied
 * DNS records.
 *
 * You supply a CSR (keeping the private key to yourself); Cloudflare signs
 * it synchronously and returns the certificate PEM. The endpoints are
 * top-level (`/certificates`) — the zone is implied by the hostnames in the
 * request, which must belong to zones on your account.
 *
 * Certificates are fully immutable: there is no update API, so changing any
 * property triggers a replacement (a new certificate is issued, then the
 * old one is revoked). Destroying the resource revokes the certificate.
 * @resource
 * @product Origin CA Certificates
 * @category SSL/TLS & Certificates
 * @section Issuing a certificate
 * @example RSA certificate for a single hostname
 * ```typescript
 * const cert = yield* Cloudflare.OriginCaCertificate.OriginCaCertificate("origin-cert", {
 *   csr: originCsrPem,
 *   hostnames: ["origin.example.com"],
 *   requestType: "origin-rsa",
 *   requestedValidity: 90,
 * });
 * ```
 *
 * @example Wildcard ECDSA certificate with the default 15-year validity
 * ```typescript
 * const cert = yield* Cloudflare.OriginCaCertificate.OriginCaCertificate("wildcard-cert", {
 *   csr: wildcardCsrPem,
 *   hostnames: ["example.com", "*.example.com"],
 *   requestType: "origin-ecc",
 * });
 * ```
 *
 * @section Using the certificate
 * @example Install the signed PEM on your origin
 * ```typescript
 * // The signed certificate is returned synchronously on create:
 * const pem = cert.certificate; // "-----BEGIN CERTIFICATE-----\n..."
 * const expires = cert.expiresOn;
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/
 */
export const OriginCaCertificate = Resource<OriginCaCertificate>(TypeId, {
  aliases: ["Cloudflare.OriginCaCertificate"],
});

/**
 * Returns true if the given value is an OriginCaCertificate resource.
 */
export const isOriginCaCertificate = (
  value: unknown,
): value is OriginCaCertificate =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const OriginCaCertificateProvider = () =>
  Provider.succeed(OriginCaCertificate, {
    // Every prop change is a replacement, so all attributes are stable
    // across (non-existent) updates.
    stables: [
      "certificateId",
      "certificate",
      "csr",
      "hostnames",
      "requestType",
      "requestedValidity",
      "expiresOn",
    ],

    // Origin CA certificates are enumerated per zone (the list endpoint
    // requires a `zone_id` query param). Fan out across every zone on the
    // account and flatten. The list response omits the csr and requested
    // validity, so `toAttributes` fills them with the defaults — matching the
    // cold/unowned `read` shape. Origin CA endpoints may require the special
    // Origin CA Key auth; a zone we can't enumerate rejects with `Forbidden`,
    // which we skip rather than fail (the array stays as complete as the
    // credentials allow).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          originCa.listOriginCaCertificates.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  .filter((cert) => cert.id != null)
                  .map((cert): Attributes => toAttributes(cert)),
              ),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed([] as Attributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news }) {
      const o = olds as Props | undefined;
      const n = news as Props;
      // No prior props to compare against — let the engine decide.
      if (o?.csr === undefined) return undefined;
      // There is no update API for Origin CA certificates — every change
      // is a replacement.
      if (
        o.csr !== n.csr ||
        o.requestType !== n.requestType ||
        (o.requestedValidity ?? DEFAULT_VALIDITY) !==
          (n.requestedValidity ?? DEFAULT_VALIDITY) ||
        !sameHostnames(o.hostnames, n.hostnames)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      // Owned path: refresh by our persisted certificate id. A revoked
      // certificate is still returned by GET (with `revokedAt` set) but is
      // gone for all practical purposes.
      if (output?.certificateId) {
        const observed = yield* getCertificate(output.certificateId);
        return observed
          ? toAttributes(observed, { ...olds, ...output })
          : undefined;
      }

      // Cold read — Origin CA certificates have no name or tags, so the
      // only identity available is the exact hostname set within the zone
      // implied by the hostnames. A match cannot be proven to be ours, so
      // brand it `Unowned` and let the engine gate takeover behind the
      // adopt policy. Ambiguity (several live certs with the same
      // hostnames) means no identity at all — report missing and recreate
      // (certificates are free and revocation is harmless).
      // Output-valued hostname elements don't survive a `creating`-state
      // round-trip (they deserialize as null/undefined) — without a concrete
      // hostname there is no identity to search by.
      if (typeof olds?.hostnames?.[0] !== "string") return undefined;
      const matches = yield* findByHostnames(olds.hostnames);
      if (matches.length !== 1) return undefined;
      const observed = yield* getCertificate(matches[0].id!);
      return observed ? Unowned(toAttributes(observed, olds)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe — the certificate id cached on `output` is a hint, not a
      // guarantee: a missing or revoked certificate falls through to
      // "missing" and ensure re-issues.
      const observed = output?.certificateId
        ? yield* getCertificate(output.certificateId)
        : undefined;

      // Ensure — issue when missing. Issuance is synchronous: the signed
      // PEM comes back in the create response. Ids are server-assigned, so
      // there is no AlreadyExists race to tolerate.
      if (!observed) {
        const created = yield* originCa.createOriginCaCertificate({
          csr: news.csr,
          hostnames: news.hostnames,
          requestType: news.requestType,
          requestedValidity: news.requestedValidity ?? DEFAULT_VALIDITY,
        });
        return toAttributes(created, news);
      }

      // Sync — certificates are immutable; any prop change was already
      // routed to replacement by diff, so there is nothing to converge.
      // GET omits the csr and requested validity, so fill them from the
      // desired props (they are guaranteed equal here).
      return toAttributes(observed, news);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Delete = revoke. Idempotent: an unknown id (1101) or an
      // already-revoked certificate (1014) both mean "gone".
      //
      // `CertificateRevocationFailed` (code 1000) is the dual-use generic
      // "API errors encountered" Cloudflare returns when a revoke blips —
      // most often during the replace-time GC delete, when the old
      // certificate is revoked right after its replacement was issued.
      // Left untyped it surfaced as `UnknownCloudflareError` and aborted the
      // delete, orphaning the old certificate (it is no longer in state, so
      // a later `stack.destroy()` cannot reclaim it). Bounded-retry the
      // transient failure, then read back: a revoked/absent certificate
      // counts as deleted; a still-live one re-raises so the leak is never
      // silent.
      yield* originCa
        .deleteOriginCaCertificate({ certificateId: output.certificateId })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "CertificateRevocationFailed",
            schedule: Schedule.exponential("500 millis"),
            times: 6,
          }),
          Effect.catchTag("CertificateNotFound", () => Effect.void),
          Effect.catchTag("CertificateAlreadyRevoked", () => Effect.void),
          Effect.catchTag("CertificateRevocationFailed", (e) =>
            getCertificate(output.certificateId).pipe(
              Effect.flatMap((cert) => (cert ? Effect.fail(e) : Effect.void)),
            ),
          ),
        );
    }),
  });

const DEFAULT_VALIDITY = 5475;

/**
 * Read a certificate by id, mapping "gone" to `undefined`. Gone is either
 * `CertificateNotFound` (Cloudflare error code 1101) or a successful GET of
 * an already-revoked certificate (`revokedAt` set).
 */
const getCertificate = (certificateId: string) =>
  originCa.getOriginCaCertificate({ certificateId }).pipe(
    Effect.map((cert) => (cert.revokedAt ? undefined : cert)),
    Effect.catchTag("CertificateNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find live certificates with exactly the given hostname set. The zone is
 * implied by the hostnames: resolve the registered zone by walking the
 * suffixes of the first hostname (wildcard labels stripped), then scan the
 * zone's certificate list. Revoked certificates drop out of the list
 * immediately, so every match is live.
 */
const findByHostnames = (hostnames: string[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const hostname = hostnames[0].replace(/^\*\./, "");
    const zoneId = yield* resolveZoneIdForHostname(accountId, hostname);
    if (!zoneId) return [];
    const certs = yield* originCa.listOriginCaCertificates
      .items({ zoneId })
      .pipe(
        Stream.filter((cert) => sameHostnames([...cert.hostnames], hostnames)),
        Stream.runCollect,
      );
    return [...certs].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  });

/**
 * Resolve the zone id for a hostname by trying each suffix of the hostname
 * as a zone name (e.g. `a.b.example.com` → `a.b.example.com`,
 * `b.example.com`, `example.com`). Returns `undefined` when no zone on the
 * account matches.
 */
const resolveZoneIdForHostname = (accountId: string, hostname: string) =>
  Effect.gen(function* () {
    const parts = hostname.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts.slice(i).join(".");
      const zone = yield* findZoneByName({ accountId, name });
      if (zone) return zone.id;
    }
    return undefined;
  });

const sameHostnames = (
  observed: readonly string[],
  desired: readonly string[],
) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

type CertificateShape = {
  id?: string | null;
  certificate?: string | null;
  csr?: string | null;
  hostnames: readonly string[];
  requestType?: string | null;
  requestedValidity?: number | null;
  expiresOn?: string | null;
};

/**
 * GET/list responses omit the `csr` and `requested_validity` fields, so
 * fill them from the desired props (reconcile) or prior state (read).
 */
const toAttributes = (
  cert: CertificateShape,
  fallback?: {
    csr?: string;
    requestType?: RequestType;
    requestedValidity?: number;
  },
): Attributes => ({
  certificateId: cert.id!,
  certificate: cert.certificate ?? "",
  csr: cert.csr ?? fallback?.csr ?? "",
  hostnames: [...cert.hostnames],
  requestType: (cert.requestType ??
    fallback?.requestType ??
    "origin-rsa") as RequestType,
  requestedValidity:
    cert.requestedValidity ?? fallback?.requestedValidity ?? DEFAULT_VALIDITY,
  expiresOn: cert.expiresOn ?? undefined,
});
