import { Services } from "@distilled.cloud/hetzner";
import type { GetCertificateResponseCertificate } from "@distilled.cloud/hetzner/certificates";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { arrayEqualsUnordered } from "../Util/equal.ts";
import { waitForAction } from "./actions.ts";
import {
  alchemyLabelKeys,
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

export type CertificateType = "uploaded" | "managed";

export type CertificateStatus = {
  /** Let's Encrypt issuance state. `undefined` for uploaded Certificates. */
  issuance?: "pending" | "completed" | "failed" | (string & {});
  /** Let's Encrypt renewal state. `undefined` for uploaded Certificates. */
  renewal?: "scheduled" | "pending" | "failed" | "unavailable" | (string & {});
  /** Present when issuance or renewal is `failed`. */
  error?: { code?: string; message?: string };
};

export type UploadedCertificateProps = {
  /**
   * Upload an existing PEM certificate and private key. You monitor
   * expiry and handle renewal yourself.
   * @default "uploaded"
   */
  type?: "uploaded";
  /**
   * Name of the Certificate. Must be unique per Hetzner project. If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id.
   */
  name?: string;
  /**
   * Certificate and chain in PEM format, in order so that each record
   * directly certifies the one preceding. Changing it replaces the
   * Certificate.
   */
  certificate: string;
  /**
   * Certificate private key in PEM format. Never returned by the API
   * and not stored in resource attributes. Changing it replaces the
   * Certificate.
   */
  privateKey: string;
  /**
   * User-defined labels (`key/value` pairs). Alchemy ownership labels
   * are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ManagedCertificateProps = {
  /**
   * Request a Let's Encrypt Certificate for `domainNames`. Only domains
   * managed by Hetzner DNS are supported. Hetzner handles renewal.
   */
  type: "managed";
  /**
   * Name of the Certificate. Must be unique per Hetzner project. If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id.
   */
  name?: string;
  /**
   * Domains and subdomains that should be contained in the Certificate.
   * Changing them replaces the Certificate.
   */
  domainNames: string[];
  /**
   * User-defined labels (`key/value` pairs). Alchemy ownership labels
   * are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type CertificateProps =
  | UploadedCertificateProps
  | ManagedCertificateProps;

export type Certificate = Resource<
  "Hetzner.Certificate",
  CertificateProps,
  {
    /** Numeric Hetzner Certificate id. */
    id: number;
    /** Name of the Certificate (unique per project). */
    name: string;
    /** `uploaded` or `managed`. */
    type: CertificateType;
    /**
     * Certificate and chain in PEM format. `undefined` while a managed
     * Certificate is still being issued.
     */
    certificate: string | undefined;
    /** SHA256 fingerprint of the Certificate. */
    fingerprint: string | undefined;
    /** Domains and subdomains covered by the Certificate. */
    domainNames: string[];
    /** RFC3339 instant when the Certificate becomes valid. */
    notValidBefore: string | undefined;
    /** RFC3339 instant when the Certificate stops being valid. */
    notValidAfter: string | undefined;
    /** RFC3339 creation timestamp. */
    created: string;
    /** User-defined labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Managed issuance/renewal status. `undefined` for uploaded Certificates. */
    status: CertificateStatus | undefined;
    /** Resources currently using the Certificate. */
    usedBy: { id: number; type: string }[];
  },
  never,
  Providers
>;

/**
 * A Hetzner Cloud TLS Certificate. Upload a PEM (`type: "uploaded"`, the
 * default) or request a Let's Encrypt Certificate for domains in Hetzner
 * DNS (`type: "managed"`).
 *
 * `name` and `labels` update in place. Changing the type, the uploaded
 * PEM/key, or the managed domain list replaces the Certificate.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#certificates
 *
 * ### Uploading a Certificate
 * **Example:** Generated name
 * ```typescript
 * const cert = yield* Hetzner.Certificate("web", {
 *   certificate: pem,
 *   privateKey: key,
 * });
 * ```
 *
 * **Example:** Explicit name and labels
 * ```typescript
 * const cert = yield* Hetzner.Certificate("web", {
 *   name: "my-website-cert",
 *   certificate: pem,
 *   privateKey: key,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Managed Let's Encrypt
 * **Example:** Issue for Hetzner DNS domains
 * ```typescript
 * const cert = yield* Hetzner.Certificate("le", {
 *   type: "managed",
 *   domainNames: ["example.com", "www.example.com"],
 * });
 * ```
 *
 * @resource
 */
export const Certificate = Resource<Certificate>("Hetzner.Certificate");

export class CertificateNotResolved extends Data.TaggedError(
  "Hetzner.CertificateNotResolved",
)<{
  name: string;
}> {}

export class CertificateIssuancePending extends Data.TaggedError(
  "Hetzner.CertificateIssuancePending",
)<{
  certificateId: number;
  issuance: string;
}> {}

export class CertificateIssuanceFailed extends Data.TaggedError(
  "Hetzner.CertificateIssuanceFailed",
)<{
  certificateId: number;
  code?: string;
  message: string;
}> {}

type CloudCertificate = GetCertificateResponseCertificate;

const asType = (type: string | undefined): CertificateType =>
  type === "managed" ? "managed" : "uploaded";

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toStatus = (
  status: CloudCertificate["status"],
): CertificateStatus | undefined => {
  if (status == null) return undefined;
  return {
    issuance: status.issuance,
    renewal: status.renewal,
    error:
      status.error == null
        ? undefined
        : { code: status.error.code, message: status.error.message },
  };
};

const toAttrs = (cert: CloudCertificate): Certificate["Attributes"] => ({
  id: cert.id,
  name: cert.name,
  type: asType(cert.type),
  certificate: cert.certificate ?? undefined,
  fingerprint: cert.fingerprint ?? undefined,
  domainNames: cert.domain_names,
  notValidBefore: cert.not_valid_before ?? undefined,
  notValidAfter: cert.not_valid_after ?? undefined,
  created: cert.created,
  labels: userLabels(cert.labels),
  status: toStatus(cert.status),
  usedBy: cert.used_by.map((item) => ({ id: item.id, type: item.type })),
});

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.succeed(name ?? existing ?? undefined).pipe(
    Effect.flatMap((resolved) =>
      resolved !== undefined
        ? Effect.succeed(resolved)
        : createPhysicalName({ id, maxLength: 64 }),
    ),
  );

const normalizePem = (pem: string | undefined): string =>
  (pem ?? "").replace(/\r\n/g, "\n").trim();

const getById = (id: number) =>
  Services.certificates.getCertificate({ id }).pipe(
    Effect.map(({ certificate }) => certificate),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const findByName = (name: string) =>
  Services.certificates
    .listCertificates({ name, per_page: 50 })
    .pipe(
      Effect.map(({ certificates }) =>
        certificates.find((cert) => cert.name === name),
      ),
    );

const findByLabels = (labels: Record<string, string>) =>
  Services.certificates
    .listCertificates({
      label_selector: labelSelector(labels),
      per_page: 50,
    })
    .pipe(Effect.map(({ certificates }) => certificates[0]));

const observe = Effect.fn(function* (input: {
  id?: number;
  name?: string;
  logicalId: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.name !== undefined) {
    const byName = yield* findByName(input.name);
    if (byName !== undefined) return byName;
  }
  const internal = yield* createInternalLabels(input.logicalId);
  return yield* findByLabels(internal);
});

const deleteById = (id: number) =>
  Services.certificates
    .deleteCertificate({ id })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

const waitForManagedIssuance = (id: number) =>
  Services.certificates.getCertificate({ id }).pipe(
    Effect.flatMap(({ certificate }) =>
      Effect.gen(function* () {
        const issuance = certificate.status?.issuance;
        if (issuance === "failed") {
          return yield* new CertificateIssuanceFailed({
            certificateId: id,
            code: certificate.status?.error?.code,
            message:
              certificate.status?.error?.message ??
              "Certificate issuance failed",
          });
        }
        if (issuance !== undefined && issuance !== "completed") {
          return yield* new CertificateIssuancePending({
            certificateId: id,
            issuance,
          });
        }
        return certificate;
      }),
    ),
    Effect.retry({
      while: (e) =>
        e._tag === "Hetzner.CertificateIssuancePending" ||
        e._tag === "NotFound" ||
        e._tag === "TooManyRequests" ||
        e._tag === "ServiceUnavailable" ||
        e._tag === "InternalServerError" ||
        e._tag === "BadGateway" ||
        e._tag === "GatewayTimeout",
      times: 10,
      schedule: Schedule.min([
        Schedule.exponential(Duration.millis(500), 1.5),
        Schedule.spaced(Duration.seconds(5)),
      ]),
    }),
  );

const ensureCreated = Effect.fn(function* ({
  name,
  news,
  desiredLabels,
}: {
  name: string;
  news: CertificateProps;
  desiredLabels: Record<string, string>;
}) {
  const created =
    news.type === "managed"
      ? yield* Services.certificates
          .createCertificate({
            name,
            type: "managed",
            domain_names: news.domainNames,
            labels: desiredLabels,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)))
      : yield* Services.certificates
          .createCertificate({
            name,
            type: "uploaded",
            certificate: news.certificate,
            private_key: news.privateKey,
            labels: desiredLabels,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));

  if (created === undefined) {
    return undefined;
  }

  const cleanup = deleteById(created.certificate.id);
  if (created.action) {
    yield* waitForAction(created.action).pipe(Effect.tapError(() => cleanup));
  }
  if (asType(created.certificate.type) === "managed") {
    return yield* waitForManagedIssuance(created.certificate.id).pipe(
      Effect.tapError(() => cleanup),
    );
  }
  return created.certificate;
});

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: [
      "id",
      "type",
      "fingerprint",
      "certificate",
      "domainNames",
      "notValidBefore",
      "notValidAfter",
      "created",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;

      const nextType = news.type ?? "uploaded";
      const previousName = olds?.name ?? output.name;
      const nextName = news.name ?? previousName;
      const deleteFirst = nextName === previousName;

      if (nextType !== output.type) {
        return { action: "replace" as const, deleteFirst };
      }

      if (news.type === "managed") {
        if (!arrayEqualsUnordered(news.domainNames, output.domainNames)) {
          return { action: "replace" as const, deleteFirst };
        }
        return undefined;
      }

      const prevCert =
        olds !== undefined && olds.type !== "managed"
          ? olds.certificate
          : undefined;
      const prevKey =
        olds !== undefined && olds.type !== "managed"
          ? olds.privateKey
          : undefined;
      if (
        (prevCert !== undefined &&
          normalizePem(news.certificate) !== normalizePem(prevCert)) ||
        (prevKey !== undefined &&
          normalizePem(news.privateKey) !== normalizePem(prevKey))
      ) {
        return { action: "replace" as const, deleteFirst };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* toName(id, olds?.name, output?.name);
      const existing = yield* observe({
        id: output?.id,
        name,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Services.certificates.listCertificates
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk, toAttrs)),
        ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* toName(id, news.name, output?.name);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* observe({
        id: output?.id,
        name,
        logicalId: id,
      });

      if (current === undefined) {
        const created = yield* ensureCreated({
          name,
          news,
          desiredLabels,
        });
        current =
          created ??
          (yield* observe({
            id: output?.id,
            name,
            logicalId: id,
          }));
      }

      if (current === undefined) {
        return yield* new CertificateNotResolved({ name });
      }

      if (asType(current.type) === "managed") {
        const issuance = current.status?.issuance;
        if (issuance === "pending") {
          current = yield* waitForManagedIssuance(current.id);
        } else if (issuance === "failed") {
          return yield* new CertificateIssuanceFailed({
            certificateId: current.id,
            code: current.status?.error?.code,
            message:
              current.status?.error?.message ?? "Certificate issuance failed",
          });
        }
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const nameChanged = current.name !== name;
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      if (nameChanged || labelsChanged) {
        const updated = yield* Services.certificates.updateCertificate({
          id: current.id,
          name: nameChanged ? name : undefined,
          labels: labelsChanged ? desiredLabels : undefined,
        });
        current = updated.certificate;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteById(output.id);
    }),
  });
