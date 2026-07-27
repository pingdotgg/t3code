import * as customCertificates from "@distilled.cloud/cloudflare/custom-certificates";
import crypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.CustomCertificate.CustomCertificate" as const;
type TypeId = typeof TypeId;

/**
 * How Cloudflare builds the certificate chain served to clients.
 *
 * A `ubiquitous` bundle has the highest probability of being verified
 * everywhere, even by clients using outdated or unusual trust stores. An
 * `optimal` bundle uses the shortest chain and newest intermediates. `force`
 * serves exactly the certificate you uploaded.
 */
export type BundleMethod = "ubiquitous" | "optimal" | "force";

/**
 * SNI support of the uploaded certificate. `legacy_custom` enables support
 * for legacy clients which do not include SNI in the TLS handshake (requires
 * dedicated IPs); `sni_custom` is the recommended modern option.
 */
export type Type = "legacy_custom" | "sni_custom";

/**
 * Lifecycle status of a custom certificate. Uploads are asynchronous —
 * a certificate transitions `initializing` → `active`.
 */
export type Status =
  | "active"
  | "expired"
  | "deleted"
  | "pending"
  | "initializing"
  // Keep the union open so new Cloudflare statuses aren't blocked by stale
  // types.
  | (string & {});

/**
 * Geo Key Manager region restriction: where the certificate's private key
 * may be held locally for optimal TLS performance.
 */
export interface GeoRestrictions {
  /**
   * Region label: `us`, `eu`, or `highest_security`.
   */
  label: "us" | "eu" | "highest_security";
}

export interface Props {
  /**
   * Zone the certificate is uploaded to. Custom certificates are a
   * zone-level feature (Business and Enterprise plans only).
   *
   * Immutable — moving a certificate between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * The zone's SSL certificate — the leaf certificate plus any
   * intermediates, in PEM format. Plain `string` (not `string`) so
   * its content hash is statically computable.
   *
   * Mutable — Cloudflare PATCHes a new certificate onto the same record,
   * keeping the certificate id stable across rotations.
   */
  certificate: string;
  /**
   * The certificate's private key in PEM format. Not required when
   * `customCsrId` is provided, in which case the private key is retrieved
   * from the CSR record held by Cloudflare.
   *
   * Write-only — Cloudflare never echoes the key back; a content hash of
   * the certificate/key pair is persisted in the attributes for diffing.
   */
  privateKey?: Redacted.Redacted<string>;
  /**
   * The identifier of a Custom CSR held by Cloudflare to source the private
   * key from, as an alternative to uploading `privateKey`.
   */
  customCsrId?: string;
  /**
   * How Cloudflare builds the certificate chain served to clients.
   * @default "ubiquitous"
   */
  bundleMethod?: BundleMethod;
  /**
   * SNI support: `sni_custom` (recommended) or `legacy_custom` (supports
   * non-SNI clients; requires dedicated IPs).
   *
   * Immutable — the PATCH endpoint does not accept `type`, so changing it
   * triggers a replacement.
   * @default "legacy_custom"
   */
  type?: Type;
  /**
   * Geo Key Manager region restriction for the private key. Mutually
   * exclusive with `policy`.
   */
  geoRestrictions?: GeoRestrictions;
  /**
   * Geo Key Manager policy expression (e.g.
   * `(country: US) or (region: EU)`) that determines where the private key
   * is held. Mutually exclusive with `geoRestrictions`. Cloudflare echoes
   * this back as the `policyRestrictions` attribute.
   */
  policy?: string;
  /**
   * The environment to deploy the certificate to. Staging deploys are an
   * Enterprise feature. Write-only — not echoed back by the API.
   * @default "production"
   */
  deploy?: "staging" | "production";
  /**
   * The order/priority in which the certificate is used in a request. A
   * higher priority breaks ties across overlapping `legacy_custom`
   * certificates. Synced via the prioritize endpoint when it differs from
   * the observed value.
   * @default API-assigned
   */
  priority?: number;
}

export interface Attributes {
  /** Cloudflare-assigned identifier of the custom certificate. Stable across in-place certificate rotations. */
  certificateId: string;
  /** Zone the certificate belongs to. */
  zoneId: string;
  /** Hostnames covered by the certificate. */
  hosts: string[];
  /** The certificate authority that issued the certificate. */
  issuer: string | undefined;
  /** The type of hash used for the certificate signature. */
  signature: string | undefined;
  /** ISO8601 date the certificate expires. */
  expiresOn: string | undefined;
  /** ISO8601 date the certificate was uploaded to Cloudflare. */
  uploadedOn: string | undefined;
  /** ISO8601 date the certificate was last modified. */
  modifiedOn: string | undefined;
  /** How Cloudflare builds the certificate chain served to clients. */
  bundleMethod: BundleMethod | undefined;
  /** SNI support the certificate was uploaded with. Not echoed by the API — persisted from the input props. */
  type: Type;
  /** The order/priority in which the certificate is used in a request. */
  priority: number | undefined;
  /** Lifecycle status of the certificate (`initializing` → `active`). */
  status: Status | undefined;
  /** Geo Key Manager policy expression, as echoed by the API for the `policy` prop. */
  policyRestrictions: string | undefined;
  /** Geo Key Manager region restriction, if set. */
  geoRestrictions: GeoRestrictions | undefined;
  /**
   * SHA-256 hash of the uploaded certificate/private key pair. Cloudflare
   * never echoes the PEM contents back, so this hash is the diff baseline
   * for deciding whether to re-push the certificate (a documented exception
   * to "observation > assumption").
   */
  contentHash: string;
}

export type CustomCertificate = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * A Cloudflare custom (BYO) edge certificate — upload your own SSL
 * certificate and private key to be served at Cloudflare's edge for a zone.
 *
 * Custom certificates are a **Business / Enterprise** feature; on lower
 * plans every API call fails with the typed `PlanLevelNotAllowed` error
 * (Cloudflare error code 1011).
 *
 * The certificate id is stable across in-place rotations: PATCHing a new
 * `certificate`/`privateKey` pair keeps the same id. Cloudflare never echoes
 * the PEM contents back, so a SHA-256 content hash of the pair is persisted
 * in the attributes and used as the rotation diff baseline. Only `zoneId`
 * and `type` force a replacement.
 * @resource
 * @product Custom Certificates
 * @category SSL/TLS & Certificates
 * @section Uploading a certificate
 * @example Basic SNI certificate
 * ```typescript
 * const cert = yield* Cloudflare.CustomCertificate.CustomCertificate("EdgeCert", {
 *   zoneId: zone.zoneId,
 *   certificate: certPem,
 *   privateKey: Redacted.make(keyPem),
 *   type: "sni_custom",
 * });
 * ```
 *
 * @example Optimal bundle with a Geo Key Manager region
 * ```typescript
 * yield* Cloudflare.CustomCertificate.CustomCertificate("EuCert", {
 *   zoneId: zone.zoneId,
 *   certificate: certPem,
 *   privateKey: Redacted.make(keyPem),
 *   type: "sni_custom",
 *   bundleMethod: "optimal",
 *   geoRestrictions: { label: "eu" },
 * });
 * ```
 *
 * @section Rotating the certificate
 * @example Rotate in place
 * ```typescript
 * // Changing `certificate`/`privateKey` PATCHes the same certificate id —
 * // no replacement, no coverage gap.
 * yield* Cloudflare.CustomCertificate.CustomCertificate("EdgeCert", {
 *   zoneId: zone.zoneId,
 *   certificate: renewedCertPem,
 *   privateKey: Redacted.make(renewedKeyPem),
 *   type: "sni_custom",
 * });
 * ```
 *
 * @section Prioritizing overlapping certificates
 * @example Explicit priority
 * ```typescript
 * // Higher priority breaks ties across overlapping legacy_custom certs.
 * yield* Cloudflare.CustomCertificate.CustomCertificate("PrimaryCert", {
 *   zoneId: zone.zoneId,
 *   certificate: certPem,
 *   privateKey: Redacted.make(keyPem),
 *   priority: 1,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/edge-certificates/custom-certificates/
 */
export const CustomCertificate = Resource<CustomCertificate>(TypeId, {
  aliases: ["Cloudflare.CustomCertificate"],
});

/**
 * Returns true if the given value is a CustomCertificate resource.
 */
export const isCustomCertificate = (
  value: unknown,
): value is CustomCertificate =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CustomCertificateProvider = () =>
  Provider.succeed(CustomCertificate, {
    stables: ["certificateId", "zoneId", "type", "uploadedOn"],

    // Zone-scoped collection: fan out over every zone and exhaustively
    // paginate that zone's custom certificates. The PEM contents and the
    // uploaded `type` are write-only (never echoed back), so — exactly like
    // `read`'s cold adoption path — the unknowable `type`/`contentHash`
    // default to `legacy_custom`/`""`. Plan-gated zones reject the route with
    // the typed `PlanLevelNotAllowed` (custom certs are Business/Enterprise),
    // zones that can't host custom certs (partial/pending/deleted between
    // list and read) reject with `ZoneNotFound` ("Cannot find a valid zone"),
    // and freshly-scoped tokens may blip `Forbidden`; all three skip the zone
    // so enumeration still returns every zone it can read.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          customCertificates.listCustomCertificates
            .pages({ zoneId: zone.id })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).map(
                    (cert): Attributes =>
                      toAttributes(cert, {
                        type: "legacy_custom",
                        contentHash: "",
                      }),
                  ),
                ),
              ),
              Effect.catchTag(
                ["PlanLevelNotAllowed", "ZoneNotFound", "Forbidden"],
                () => Effect.succeed([] as Attributes[]),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // Zone move replaces. zoneId is Input<string>; compare only once
      // both sides are concrete.
      const oldZone =
        output?.zoneId ??
        (olds !== undefined && isResolved(olds)
          ? (olds.zoneId as string | undefined)
          : undefined);
      if (
        typeof oldZone === "string" &&
        typeof news.zoneId === "string" &&
        oldZone !== news.zoneId
      ) {
        return { action: "replace" } as const;
      }
      // `type` is create-only (the PATCH body does not accept it).
      const oldType =
        output?.type ??
        (olds !== undefined && isResolved(olds) ? olds.type : undefined) ??
        "legacy_custom";
      if ((news.type ?? "legacy_custom") !== oldType) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (zoneId === undefined) return undefined;

      // Owned path: refresh by our persisted certificate id.
      if (output?.certificateId) {
        const observed = yield* getCertificate(zoneId, output.certificateId);
        return observed
          ? toAttributes(observed, {
              type: output.type,
              contentHash: output.contentHash,
            })
          : undefined;
      }

      // Cold path: state was lost. Custom certificates carry no ownership
      // markers and no name, so identify the desired certificate by its
      // parsed expiry timestamp (an upload of the same PEM always yields
      // the same `expires_on`) and report it as `Unowned` so the engine
      // gates takeover behind the adopt policy.
      if (olds?.certificate === undefined) return undefined;
      const parsed = yield* parseCertificate(olds.certificate);
      const observed = yield* findByExpiry(zoneId, parsed.expiresAtMs);
      if (observed) {
        return Unowned(
          toAttributes(observed, {
            type: olds.type ?? "legacy_custom",
            // The live cert/key contents are unknowable — force one
            // convergence PATCH after adoption.
            contentHash: "",
          }),
        );
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const customCsrId = news.customCsrId as string | undefined;
      const type = news.type ?? output?.type ?? "legacy_custom";
      const desiredHash = yield* hashContent(news);

      // 1. Observe — the certificate id cached on `output` is a hint, not
      //    a guarantee: a missing certificate falls through to create.
      let observed = output?.certificateId
        ? yield* getCertificate(zoneId, output.certificateId)
        : undefined;

      // 2. Ensure — upload when missing. Certificates have no uniqueness
      //    constraint on Cloudflare's side, so there is no AlreadyExists
      //    race to tolerate.
      if (!observed) {
        observed = yield* customCertificates.createCustomCertificate({
          zoneId,
          certificate: news.certificate,
          privateKey: news.privateKey
            ? Redacted.value(news.privateKey)
            : undefined,
          customCsrId,
          bundleMethod: news.bundleMethod,
          type: news.type,
          geoRestrictions: news.geoRestrictions,
          policy: news.policy,
          deploy: news.deploy,
        });
        // The freshly uploaded contents are the desired contents.
        observed = yield* syncPriority(zoneId, observed, news.priority);
        return toAttributes(observed, { type, contentHash: desiredHash });
      }

      // 3. Sync — diff observed cloud state against desired. The PEM
      //    contents are write-only, so the persisted content hash is the
      //    baseline for the certificate/key pair; everything else diffs
      //    against the observed response.
      const certDirty = output?.contentHash !== desiredHash;
      const bundleDirty =
        news.bundleMethod !== undefined &&
        observed.bundleMethod !== news.bundleMethod;
      const geoDirty =
        news.geoRestrictions !== undefined &&
        observed.geoRestrictions?.label !== news.geoRestrictions.label;
      const policyDirty =
        news.policy !== undefined &&
        (observed.policyRestrictions ?? undefined) !== news.policy;

      if (certDirty || bundleDirty || geoDirty || policyDirty) {
        observed = yield* customCertificates.patchCustomCertificate({
          zoneId,
          customCertificateId: observed.id,
          ...(certDirty
            ? {
                certificate: news.certificate,
                privateKey: news.privateKey
                  ? Redacted.value(news.privateKey)
                  : undefined,
                customCsrId,
                deploy: news.deploy,
              }
            : {}),
          ...(bundleDirty ? { bundleMethod: news.bundleMethod } : {}),
          ...(geoDirty ? { geoRestrictions: news.geoRestrictions } : {}),
          ...(policyDirty ? { policy: news.policy } : {}),
        });
      }

      observed = yield* syncPriority(zoneId, observed, news.priority);
      return toAttributes(observed, { type, contentHash: desiredHash });
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* customCertificates
        .deleteCustomCertificate({
          zoneId: output.zoneId,
          customCertificateId: output.certificateId,
        })
        .pipe(Effect.catchTag("CustomCertificateNotFound", () => Effect.void));
    }),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ObservedCertificate = customCertificates.GetCustomCertificateResponse;

/**
 * Read a certificate by id, mapping "gone" (`CustomCertificateNotFound`,
 * HTTP 404) to `undefined`.
 */
const getCertificate = (zoneId: string, customCertificateId: string) =>
  customCertificates.getCustomCertificate({ zoneId, customCertificateId }).pipe(
    Effect.map((cert): ObservedCertificate | undefined => cert),
    Effect.catchTag("CustomCertificateNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Find a certificate in the zone whose `expires_on` matches the desired
 * PEM's parsed expiry. Uploading the same certificate always produces the
 * same expiry, making it the best identity available (the API neither
 * echoes the PEM nor exposes the serial number). If several match, pick the
 * oldest upload for determinism.
 */
const findByExpiry = (zoneId: string, expiresAtMs: number) =>
  customCertificates.listCustomCertificates.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter(
          (cert) =>
            cert.expiresOn != null &&
            Date.parse(cert.expiresOn) === expiresAtMs,
        )
        .sort((a, b) => (a.uploadedOn ?? "").localeCompare(b.uploadedOn ?? ""))
        .at(0),
    ),
  );

/**
 * Parse the leaf certificate of a PEM bundle. Sync CPU-only Node API,
 * wrapped in `Effect.try` so a malformed PEM surfaces as a typed failure
 * instead of a thrown exception.
 */
const parseCertificate = (pem: string) =>
  Effect.try({
    try: () => {
      const x509 = new crypto.X509Certificate(pem);
      return { expiresAtMs: Date.parse(x509.validTo) };
    },
    catch: (cause) =>
      new Error(`failed to parse certificate PEM: ${cause}`, { cause }),
  });

/**
 * SHA-256 over the write-only inputs (certificate, private key, CSR id).
 * Persisted in the attributes as the rotation diff baseline because the API
 * never returns the PEM contents.
 */
const hashContent = (news: Props) =>
  Effect.sync(() =>
    crypto
      .createHash("sha256")
      .update(news.certificate)
      .update("\n")
      .update(news.privateKey ? Redacted.value(news.privateKey) : "")
      .update("\n")
      .update((news.customCsrId as string | undefined) ?? "")
      .digest("hex"),
  );

/**
 * Converge the certificate's priority via the prioritize endpoint when an
 * explicit `priority` is desired and differs from the observed value.
 */
const syncPriority = (
  zoneId: string,
  observed: ObservedCertificate,
  priority: number | undefined,
) =>
  Effect.gen(function* () {
    if (priority === undefined || observed.priority === priority) {
      return observed;
    }
    yield* customCertificates.putPrioritize({
      zoneId,
      certificates: [{ id: observed.id, priority }],
    });
    // Re-observe so the returned attributes reflect the final state.
    const fresh = yield* getCertificate(zoneId, observed.id);
    return fresh ?? observed;
  });

const toAttributes = (
  cert: ObservedCertificate,
  meta: { type: Type; contentHash: string },
): Attributes => ({
  certificateId: cert.id,
  zoneId: cert.zoneId,
  hosts: [...(cert.hosts ?? [])],
  issuer: cert.issuer ?? undefined,
  signature: cert.signature ?? undefined,
  expiresOn: cert.expiresOn ?? undefined,
  uploadedOn: cert.uploadedOn ?? undefined,
  modifiedOn: cert.modifiedOn ?? undefined,
  bundleMethod:
    (cert.bundleMethod as BundleMethod | null | undefined) ?? undefined,
  type: meta.type,
  priority: cert.priority ?? undefined,
  status: cert.status ?? undefined,
  policyRestrictions: cert.policyRestrictions ?? undefined,
  geoRestrictions: cert.geoRestrictions?.label
    ? { label: cert.geoRestrictions.label as "us" | "eu" | "highest_security" }
    : undefined,
  contentHash: meta.contentHash,
});
