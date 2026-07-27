import * as mtls from "@distilled.cloud/cloudflare/mtls-certificates";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.MtlsCertificate.MtlsCertificate" as const;
type TypeId = typeof TypeId;

/**
 * How the certificate was created and who manages it. Certificates uploaded
 * through this resource are always `"custom"`.
 */
export type Type =
  | "custom"
  | "gateway_managed"
  | "access_managed"
  // Keep the union open so new Cloudflare types aren't blocked by stale types.
  | (string & {});

export type Props = {
  /**
   * Optional human-readable name for the certificate. If omitted, a unique
   * name will be generated. There is no update API, so changing the name
   * triggers a replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Indicates whether the certificate is a CA certificate (`true`) used to
   * validate client certificates, or a leaf certificate (`false`) presented
   * by Cloudflare to your origin. Cannot be changed after upload — updating
   * this property triggers a replacement.
   */
  ca: boolean;
  /**
   * The certificate in PEM format. A root CA certificate when `ca: true`,
   * or a leaf certificate (chain) when `ca: false`. Cannot be changed after
   * upload — updating this property triggers a replacement.
   */
  certificates: string;
  /**
   * The private key for the certificate in PEM format. Required when
   * uploading a leaf certificate (`ca: false`) that Cloudflare must present
   * to your origin. Cannot be changed after upload — updating this property
   * triggers a replacement.
   */
  privateKey?: Redacted.Redacted<string>;
};

export type Attributes = {
  /**
   * Unique identifier of the uploaded certificate.
   */
  mtlsCertificateId: string;
  /**
   * The Cloudflare account the certificate was uploaded to.
   */
  accountId: string;
  /**
   * Human-readable name of the certificate.
   */
  name: string | undefined;
  /**
   * Whether the certificate is a CA (`true`) or leaf (`false`) certificate.
   */
  ca: boolean;
  /**
   * The certificate authority that issued the certificate.
   */
  issuer: string | undefined;
  /**
   * The certificate serial number.
   */
  serialNumber: string | undefined;
  /**
   * The type of hash used for the certificate signature.
   */
  signature: string | undefined;
  /**
   * When the certificate expires.
   */
  expiresOn: string | undefined;
  /**
   * When the certificate was uploaded to Cloudflare.
   */
  uploadedOn: string | undefined;
  /**
   * How the certificate was created and who manages it.
   */
  type: Type | undefined;
};

export type MtlsCertificate = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * An account-level Cloudflare mTLS certificate.
 *
 * Uploads a certificate to the account-level mTLS certificate store. Upload a
 * CA certificate (`ca: true`) to validate client certificates (referenced by
 * certificate-authority hostname associations and Hyperdrive
 * `caCertificateId`), or a leaf certificate plus private key (`ca: false`)
 * that Cloudflare presents to your origin (referenced by Worker
 * `mtls_certificate` bindings and Hyperdrive `mtlsCertificateId`).
 *
 * Certificates are immutable: there is no update API, so changing any
 * property triggers a replacement.
 * @resource
 * @product mTLS Certificates
 * @category SSL/TLS & Certificates
 * @section Uploading Certificates
 * @example CA certificate
 * ```typescript
 * const ca = yield* Cloudflare.MtlsCertificate.MtlsCertificate("client-ca", {
 *   ca: true,
 *   certificates: caPem,
 * });
 * ```
 *
 * @example Leaf certificate with private key
 * ```typescript
 * const cert = yield* Cloudflare.MtlsCertificate.MtlsCertificate("origin-client-cert", {
 *   ca: false,
 *   certificates: leafPem,
 *   privateKey: alchemy.secret.env.ORIGIN_CLIENT_KEY,
 * });
 * ```
 *
 * @example Named certificate
 * ```typescript
 * const ca = yield* Cloudflare.MtlsCertificate.MtlsCertificate("client-ca", {
 *   name: "my-client-ca",
 *   ca: true,
 *   certificates: caPem,
 * });
 * ```
 *
 * @section Referencing from Hyperdrive
 * @example Verify the origin with an uploaded CA
 * ```typescript
 * const ca = yield* Cloudflare.MtlsCertificate.MtlsCertificate("db-ca", {
 *   ca: true,
 *   certificates: caPem,
 * });
 *
 * const hd = yield* Cloudflare.Hyperdrive.Connection("my-db", {
 *   origin: { ... },
 *   mtls: {
 *     caCertificateId: ca.mtlsCertificateId,
 *     sslmode: "verify-full",
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ssl/client-certificates/
 */
export const MtlsCertificate = Resource<MtlsCertificate>(TypeId, {
  aliases: ["Cloudflare.MtlsCertificate"],
});

/**
 * Returns true if the given value is a MtlsCertificate resource.
 */
export const isMtlsCertificate = (value: unknown): value is MtlsCertificate =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const MtlsCertificateProvider = () =>
  Provider.succeed(MtlsCertificate, {
    stables: ["mtlsCertificateId", "accountId"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName =
        output?.name ?? (yield* createCertificateName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (
        oldName !== name ||
        (news.ca ?? undefined) !== (olds.ca ?? undefined) ||
        (news.certificates ?? undefined) !== (olds.certificates ?? undefined) ||
        unwrap(news.privateKey) !== unwrap(olds.privateKey)
      ) {
        // There is no update API for mTLS certificates — every change is a
        // replacement.
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.mtlsCertificateId) {
        return yield* mtls
          .getMtlsCertificate({
            accountId: acct,
            mtlsCertificateId: output.mtlsCertificateId,
          })
          .pipe(
            Effect.map((cert) => toAttributes(cert, acct)),
            Effect.catchTag("CertificateNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      // Cold read — recover by listing and matching on the deterministic
      // physical name (the only brand available; certificates have no tags).
      const name = yield* createCertificateName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? toAttributes(match, acct) : undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection — exhaustively paginate the mTLS
      // certificate store and hydrate each item into the read Attributes
      // shape (the private key is write-only and never returned).
      return yield* mtls.listMtlsCertificates.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              // Cloudflare-managed certificates (e.g. the gateway/access
              // managed CAs) reject deletion with `Unauthorized`; only
              // enumerate user-uploaded `custom` certificates for teardown.
              .filter(
                (cert) =>
                  cert.type !== "gateway_managed" &&
                  cert.type !== "access_managed",
              )
              .map((cert) => toAttributes(cert, accountId)),
          ),
        ),
      );
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name =
        output?.name ?? (yield* createCertificateName(id, news.name));

      // Observe — the certificate id is the stable identifier; fall through
      // a CertificateNotFound to the list+name match so we recover from
      // out-of-band deletes and partial state persistence.
      let observed = output?.mtlsCertificateId
        ? yield* mtls
            .getMtlsCertificate({
              accountId,
              mtlsCertificateId: output.mtlsCertificateId,
            })
            .pipe(
              Effect.catchTag("CertificateNotFound", () =>
                Effect.succeed(undefined),
              ),
            )
        : yield* findByName(accountId, name);

      // Ensure — upload if missing. Cloudflare rejects uploading a
      // certificate with identical content twice (code 1471); tolerate the
      // race (or an orphaned prior upload) by re-listing and adopting the
      // certificate with identical PEM content.
      if (!observed) {
        observed = yield* mtls
          .createMtlsCertificate({
            accountId,
            ca: news.ca,
            certificates: news.certificates,
            name,
            privateKey: unwrap(news.privateKey),
          })
          .pipe(
            Effect.catchTag("CertificateAlreadyExists", (originalError) =>
              Effect.gen(function* () {
                const match = yield* findByContent(
                  accountId,
                  news.certificates,
                );
                if (!match) return yield* Effect.fail(originalError);
                return match;
              }),
            ),
          );
      }

      return toAttributes(observed, accountId, news);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* mtls
        .deleteMtlsCertificate({
          accountId: output.accountId,
          mtlsCertificateId: output.mtlsCertificateId,
        })
        .pipe(
          Effect.catchTag(
            ["CertificateNotFound", "CertificateAlreadyDeleted"],
            () => Effect.void,
          ),
        );
    }),
  });

const createCertificateName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const findByName = (accountId: string, name: string) =>
  Effect.gen(function* () {
    const list = yield* mtls.listMtlsCertificates({ accountId });
    return list.result.find((c) => c.name === name);
  });

const findByContent = (accountId: string, certificates: string) =>
  Effect.gen(function* () {
    const list = yield* mtls.listMtlsCertificates({ accountId });
    return list.result.find(
      (c) => c.certificates?.trim() === certificates.trim(),
    );
  });

const unwrap = (
  value: Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

type CertificateShape = {
  id?: string | null;
  ca?: boolean | null;
  name?: string | null;
  issuer?: string | null;
  serialNumber?: string | null;
  signature?: string | null;
  expiresOn?: string | null;
  uploadedOn?: string | null;
  type?: Type | null;
};

const toAttributes = (
  cert: CertificateShape,
  accountId: string,
  news?: Props,
): Attributes => ({
  mtlsCertificateId: cert.id!,
  accountId,
  name: cert.name ?? undefined,
  ca: cert.ca ?? news?.ca ?? false,
  issuer: cert.issuer ?? undefined,
  serialNumber: cert.serialNumber ?? undefined,
  signature: cert.signature ?? undefined,
  expiresOn: cert.expiresOn ?? undefined,
  uploadedOn: cert.uploadedOn ?? undefined,
  type: cert.type ?? undefined,
});
