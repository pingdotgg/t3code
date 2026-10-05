import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";

const DEFAULT_LOCATION = "global";
const DEFAULT_SCOPE = "DEFAULT";
const MAX_NAME_LENGTH = 63;

export type CertificateType = "SELF_MANAGED" | "MANAGED" | "MANAGED_IDENTITY";

export type CertificateScope =
  | "DEFAULT"
  | "EDGE_CACHE"
  | "ALL_REGIONS"
  | "CLIENT_AUTH";

export type CertificateSelfManaged = {
  /** PEM-encoded certificate chain. Leaf first, then intermediates. Input-only. */
  pemCertificate?: string;
  /** PEM-encoded private key of the leaf certificate. Input-only. */
  pemPrivateKey?: string;
};

export type CertificateManaged = {
  /**
   * Domains covered by a Google-managed certificate. Wildcard domains
   * require DNS authorization. Immutable — changing them replaces the
   * certificate.
   */
  domains?: string[];
  /**
   * DnsAuthorization resource names used to prove domain ownership.
   * Immutable — changing them replaces the certificate.
   */
  dnsAuthorizations?: string[];
  /**
   * CertificateIssuanceConfig resource name for private PKI certificates.
   * Immutable — changing it replaces the certificate.
   */
  issuanceConfig?: string;
};

export type CertificateManagedIdentity = {
  /**
   * SPIFFE ID of the Managed Identity used for this certificate.
   * Immutable — changing it replaces the certificate.
   */
  identity?: string;
};

export type CertificateProps = {
  /**
   * Certificate id (the `{certificate}` segment of
   * `projects/{project}/locations/{location}/certificates/{certificate}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-zA-Z][a-zA-Z0-9_-]*`. Immutable — changing it replaces the
   * certificate.
   */
  certificateId?: string;
  /**
   * Certificate Manager location (`global`, `us-central1`, …). Immutable —
   * changing it replaces the certificate. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`. `DEFAULT` / `EDGE_CACHE` / `CLIENT_AUTH`
   * / `ALL_REGIONS` certificates live in `global`; omit or set a region
   * for a regional certificate.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Certificate serving scope. Immutable — changing it replaces the
   * certificate. Inferred from `managed` / `selfManaged` / `managedIdentity`
   * when omitted.
   * @default "DEFAULT"
   */
  scope?: CertificateScope | (string & {});
  /**
   * `SELF_MANAGED` (upload PEM), `MANAGED` (Google provisions), or
   * `MANAGED_IDENTITY`. Inferred from nested blocks when omitted.
   * Immutable — changing it replaces the certificate.
   * @default "SELF_MANAGED"
   */
  type?: CertificateType;
  /**
   * PEM certificate chain for a self-managed certificate. Input-only.
   * Changing it replaces the certificate.
   */
  pemCertificate?: string;
  /**
   * PEM private key for a self-managed certificate. Input-only. Changing
   * it replaces the certificate.
   */
  pemPrivateKey?: string;
  /**
   * Nested self-managed payload. Top-level `pemCertificate` /
   * `pemPrivateKey` take precedence when both are set.
   */
  selfManaged?: CertificateSelfManaged;
  /**
   * Google-managed certificate configuration. Immutable — changing
   * domains, DNS authorizations, or issuance config replaces the
   * certificate.
   */
  managed?: CertificateManaged;
  /**
   * Managed-identity certificate configuration. Immutable — changing
   * the identity replaces the certificate.
   */
  managedIdentity?: CertificateManagedIdentity;
};

export type Certificate = Resource<
  "GCP.CertificateManager.Certificate",
  CertificateProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/certificates/{certificate}`. */
    name: string;
    /** Certificate id (last path segment). */
    certificateId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** `SELF_MANAGED`, `MANAGED`, or `MANAGED_IDENTITY`. */
    type: CertificateType;
    /** Serving scope (`DEFAULT`, `EDGE_CACHE`, `ALL_REGIONS`, `CLIENT_AUTH`). */
    scope: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** PEM certificate chain returned by the API. */
    pemCertificate: string | undefined;
    /** Subject alternative DNS names on the certificate. */
    sanDnsnames: string[];
    /** RFC3339 expiry, if known. */
    expireTime: string | undefined;
    /** Google-managed domains, if this is a managed certificate. */
    managedDomains: string[];
    /** Provisioning state of a managed certificate. */
    managedState: string | undefined;
    /** DnsAuthorization names used by a managed certificate. */
    managedDnsAuthorizations: string[];
    /** CertificateIssuanceConfig name, if set. */
    issuanceConfig: string | undefined;
    /** SPIFFE identity of a managed-identity certificate. */
    managedIdentity: string | undefined;
    /** Provisioning-issue reason, if the managed certificate failed. */
    provisioningIssue: string | undefined;
    /** Resource names that currently reference this certificate. */
    usedBy: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Certificate Manager TLS certificate — self-managed (uploaded PEM),
 * Google-managed, or managed-identity.
 *
 * Changing `certificateId`, `location`, `scope`, certificate type,
 * managed-certificate configuration, or self-managed PEM replaces the
 * resource (Certificate Manager rejects in-place SAN list updates).
 * Description and labels update in place.
 *
 * ### Creating a Self-Managed Certificate
 * **Example:** Generated name
 * ```typescript
 * const cert = yield* GCP.CertificateManager.Certificate("FrontendTls", {
 *   pemCertificate,
 *   pemPrivateKey,
 * });
 * ```
 *
 * **Example:** Named certificate with labels
 * ```typescript
 * const cert = yield* GCP.CertificateManager.Certificate("FrontendTls", {
 *   certificateId: "app-frontend-tls",
 *   description: "prod frontend",
 *   labels: { env: "prod" },
 *   selfManaged: {
 *     pemCertificate,
 *     pemPrivateKey,
 *   },
 * });
 * ```
 *
 * ### Google-Managed Certificates
 * **Example:** Provision a managed certificate for a domain
 * ```typescript
 * const cert = yield* GCP.CertificateManager.Certificate("FrontendTls", {
 *   type: "MANAGED",
 *   managed: {
 *     domains: ["www.example.com"],
 *     dnsAuthorizations: [authorization.name],
 *   },
 * });
 * ```
 *
 * ### Regional Certificates
 * **Example:** Self-managed certificate in us-central1
 * ```typescript
 * const cert = yield* GCP.CertificateManager.Certificate("RegionalTls", {
 *   location: "us-central1",
 *   pemCertificate,
 *   pemPrivateKey,
 * });
 * ```
 *
 * @resource
 * @category CertificateManager
 */
export const Certificate = Resource<Certificate>(
  "GCP.CertificateManager.Certificate",
);

export class CertificateNotResolved extends Data.TaggedError(
  "GCP.CertificateManager.CertificateNotResolved",
)<{
  name: string;
}> {}

export class CertificateStillExists extends Data.TaggedError(
  "GCP.CertificateManager.CertificateStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `c${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "certificate";
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const normalizeScope = (scope: string | undefined) => {
  const value = (scope ?? DEFAULT_SCOPE).toUpperCase();
  return value === "SCOPE_UNSPECIFIED" || value === "" ? DEFAULT_SCOPE : value;
};

const resourceName = (
  project: string,
  location: string,
  certificateId: string,
) => `projects/${project}/locations/${location}/certificates/${certificateId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const certificatesAt = parts.lastIndexOf("certificates");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    certificateId:
      certificatesAt >= 0 && parts[certificatesAt + 1]
        ? parts[certificatesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  certificateId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (certificateId !== undefined) return certificateId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const selfManagedOf = (props: {
  pemCertificate?: string;
  pemPrivateKey?: string;
  selfManaged?: CertificateSelfManaged;
}): CertificateSelfManaged => ({
  pemCertificate: props.pemCertificate ?? props.selfManaged?.pemCertificate,
  pemPrivateKey: props.pemPrivateKey ?? props.selfManaged?.pemPrivateKey,
});

const typeOf = (
  props: {
    type?: string;
    managed?: CertificateManaged;
    managedIdentity?: CertificateManagedIdentity;
    pemCertificate?: string;
    pemPrivateKey?: string;
    selfManaged?: CertificateSelfManaged;
  },
  fallback: CertificateType = "SELF_MANAGED",
): CertificateType => {
  if (
    props.type === "SELF_MANAGED" ||
    props.type === "MANAGED" ||
    props.type === "MANAGED_IDENTITY"
  ) {
    return props.type;
  }
  if ((props.managedIdentity?.identity ?? "") !== "") {
    return "MANAGED_IDENTITY";
  }
  if (
    (props.managed?.domains?.length ?? 0) > 0 ||
    (props.managed?.dnsAuthorizations?.length ?? 0) > 0 ||
    (props.managed?.issuanceConfig ?? "") !== ""
  ) {
    return "MANAGED";
  }
  if ((selfManagedOf(props).pemCertificate ?? "") !== "") {
    return "SELF_MANAGED";
  }
  return fallback;
};

const typeFromCert = (
  cert: certificatemanager.Certificate,
): CertificateType => {
  if (cert.managedIdentity !== undefined) return "MANAGED_IDENTITY";
  if (cert.managed !== undefined) return "MANAGED";
  return "SELF_MANAGED";
};

const normalizePem = (pem: string | undefined): string =>
  (pem ?? "").replace(/\s+/g, "");

const sameList = (left?: readonly string[], right?: readonly string[]) =>
  [...(left ?? [])].sort().join("\0") === [...(right ?? [])].sort().join("\0");

const pemDiffers = (
  next: CertificateSelfManaged,
  previous: CertificateSelfManaged,
) => {
  if (
    next.pemCertificate !== undefined &&
    normalizePem(next.pemCertificate) !== normalizePem(previous.pemCertificate)
  ) {
    return true;
  }
  if (
    next.pemPrivateKey !== undefined &&
    previous.pemPrivateKey !== undefined &&
    normalizePem(next.pemPrivateKey) !== normalizePem(previous.pemPrivateKey)
  ) {
    return true;
  }
  return false;
};

const toAttrs = (cert: certificatemanager.Certificate, project: string) => {
  const name = cert.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    certificateId: parsed.certificateId,
    project: parsed.project || project,
    location: parsed.location,
    type: typeFromCert(cert),
    scope: normalizeScope(cert.scope),
    description: cert.description,
    labels: userLabels(cert.labels),
    pemCertificate: cert.pemCertificate,
    sanDnsnames: cert.sanDnsnames ?? [],
    expireTime: cert.expireTime,
    managedDomains: cert.managed?.domains ?? [],
    managedState: cert.managed?.state,
    managedDnsAuthorizations: cert.managed?.dnsAuthorizations ?? [],
    issuanceConfig: cert.managed?.issuanceConfig,
    managedIdentity: cert.managedIdentity?.identity,
    provisioningIssue: cert.managed?.provisioningIssue?.reason,
    usedBy: (cert.usedBy ?? [])
      .map((entry) => entry.name)
      .filter((value): value is string => typeof value === "string"),
    createTime: cert.createTime,
    updateTime: cert.updateTime,
  };
};

const getByName = (name: string) =>
  certificatemanager
    .getProjectsLocationsCertificates({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((cert) =>
      cert
        ? Effect.succeed(cert)
        : Effect.fail(new CertificateNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.CertificateNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((cert) =>
      cert === undefined
        ? Effect.void
        : Effect.fail(new CertificateStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.CertificateManager.CertificateStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedCertificates = (project: string) =>
  certificatemanager.listProjectsLocationsCertificates
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.certificates ?? [])),
      Stream.filter((cert) =>
        Object.keys(cert.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((cert) => toAttrs(cert, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateBody = (
  news: CertificateProps,
  type: CertificateType,
  scope: string,
  desiredLabels: Record<string, string>,
): certificatemanager.Certificate => {
  const body: certificatemanager.Certificate = {
    description: news.description,
    labels: desiredLabels,
    scope,
  };
  if (type === "MANAGED") {
    body.managed = {
      domains: news.managed?.domains,
      dnsAuthorizations: news.managed?.dnsAuthorizations,
      issuanceConfig: news.managed?.issuanceConfig,
    };
    return body;
  }
  if (type === "MANAGED_IDENTITY") {
    body.managedIdentity = {
      identity: news.managedIdentity?.identity,
    };
    return body;
  }
  const material = selfManagedOf(news);
  body.selfManaged = {
    pemCertificate: material.pemCertificate,
    pemPrivateKey: material.pemPrivateKey,
  };
  return body;
};

const immutableChanged = (
  news: CertificateProps,
  olds: Partial<CertificateProps> | undefined,
  output: Certificate["Attributes"] | undefined,
) => {
  const previousType = typeOf(
    {
      type: olds?.type ?? output?.type,
      managed:
        olds?.managed ??
        (output
          ? {
              domains: output.managedDomains,
              dnsAuthorizations: output.managedDnsAuthorizations,
              issuanceConfig: output.issuanceConfig,
            }
          : undefined),
      managedIdentity:
        olds?.managedIdentity ??
        (output?.managedIdentity
          ? { identity: output.managedIdentity }
          : undefined),
      pemCertificate: olds?.pemCertificate ?? output?.pemCertificate,
      selfManaged: olds?.selfManaged,
    },
    output?.type,
  );
  const nextType = typeOf(news, previousType);
  if (nextType !== previousType) return true;

  const previousScope = normalizeScope(olds?.scope ?? output?.scope);
  const nextScope = normalizeScope(news.scope ?? olds?.scope ?? output?.scope);
  if (previousScope !== nextScope) return true;

  if (nextType === "MANAGED") {
    const previousDomains =
      olds?.managed?.domains ?? output?.managedDomains ?? [];
    if (
      news.managed?.domains !== undefined &&
      !sameList(news.managed.domains, previousDomains)
    ) {
      return true;
    }
    const previousAuths =
      olds?.managed?.dnsAuthorizations ??
      output?.managedDnsAuthorizations ??
      [];
    if (
      news.managed?.dnsAuthorizations !== undefined &&
      !sameList(news.managed.dnsAuthorizations, previousAuths)
    ) {
      return true;
    }
    const previousIssuance =
      olds?.managed?.issuanceConfig ?? output?.issuanceConfig ?? "";
    if (
      news.managed?.issuanceConfig !== undefined &&
      news.managed.issuanceConfig !== previousIssuance
    ) {
      return true;
    }
    return false;
  }

  if (nextType === "MANAGED_IDENTITY") {
    const previousIdentity =
      olds?.managedIdentity?.identity ?? output?.managedIdentity ?? "";
    if (
      news.managedIdentity?.identity !== undefined &&
      news.managedIdentity.identity !== previousIdentity
    ) {
      return true;
    }
    return false;
  }

  // Self-managed PEM is replace: the API rejects SAN list updates
  // (`can't update list of Subject Alternative Names`).
  const nextMaterial = selfManagedOf(news);
  const previousMaterial = selfManagedOf({
    pemCertificate: olds?.pemCertificate ?? output?.pemCertificate,
    pemPrivateKey: olds?.pemPrivateKey,
    selfManaged: olds?.selfManaged,
  });
  if (
    nextMaterial.pemCertificate !== undefined &&
    previousMaterial.pemCertificate !== undefined &&
    pemDiffers(nextMaterial, previousMaterial)
  ) {
    return true;
  }

  return false;
};

export const CertificateProvider = () =>
  Provider.succeed(Certificate, {
    stables: [
      "name",
      "certificateId",
      "project",
      "location",
      "type",
      "scope",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.certificateId ?? output?.certificateId;
      const nextId = news.certificateId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        immutableChanged(news, olds, output);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateId = yield* toId(
        id,
        olds?.certificateId,
        output?.certificateId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, certificateId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwnedCertificates(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateId = yield* toId(
        id,
        news.certificateId,
        output?.certificateId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const type = typeOf(news, output?.type);
      const scope = normalizeScope(news.scope ?? output?.scope);
      const name = resourceName(env.project, location, certificateId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* certificatemanager
          .createProjectsLocationsCertificates({
            parent: `projects/${env.project}/locations/${location}`,
            certificateId,
            body: toCreateBody(news, type, scope, desiredLabels),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new CertificateNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || descriptionChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* certificatemanager.patchProjectsLocationsCertificates({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* certificatemanager
        .deleteProjectsLocationsCertificates({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
