import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type SslCertificateType = "SELF_MANAGED" | "MANAGED";

export type SslCertificateSelfManaged = {
  /** PEM-encoded certificate chain. Leaf first, then intermediates. */
  certificate?: string;
  /** PEM-encoded private key. Write-only on insert. */
  privateKey?: string;
};

export type SslCertificateManaged = {
  /**
   * Domains for a Google-managed certificate. Each certificate supports
   * up to the project quota (typically 100).
   */
  domains?: string[];
};

export type SslCertificateProps = {
  /**
   * Certificate name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the resource.
   */
  sslCertificateName?: string;
  /**
   * Optional description. Compute SSL certificates have no labels field
   * and no update API, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and any description change replaces the certificate.
   */
  description?: string;
  /**
   * `SELF_MANAGED` (upload PEM) or `MANAGED` (Google provisions). Inferred
   * from `managed.domains` vs `certificate` / `selfManaged` when omitted.
   * Immutable — changing it replaces the certificate.
   * @default "SELF_MANAGED"
   */
  type?: SslCertificateType;
  /**
   * PEM certificate chain for a self-managed certificate. Immutable —
   * changing it replaces the certificate.
   */
  certificate?: string;
  /**
   * PEM private key for a self-managed certificate. Write-only; not
   * returned by the API. Immutable — changing it replaces the certificate.
   */
  privateKey?: string;
  /**
   * Nested self-managed payload. `certificate` / `privateKey` on the
   * resource take precedence when both are set.
   */
  selfManaged?: SslCertificateSelfManaged;
  /**
   * Google-managed certificate configuration. Immutable — changing domains
   * replaces the certificate.
   */
  managed?: SslCertificateManaged;
};

export type SslCertificate = Resource<
  "GCP.Compute.SslCertificate",
  SslCertificateProps,
  {
    /** Certificate name. */
    sslCertificateName: string;
    /** Project id. */
    project: string;
    /** `SELF_MANAGED` or `MANAGED`. */
    type: SslCertificateType;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** PEM certificate returned by the API (self-managed; empty until a managed cert is ACTIVE). */
    certificate: string | undefined;
    /** RFC3339 expiry, if known. */
    expireTime: string | undefined;
    /** Subject alternative names on the certificate. */
    subjectAlternativeNames: string[];
    /** Google-managed domains, if this is a managed certificate. */
    managedDomains: string[];
    /** Provisioning status of a managed certificate. */
    managedStatus: string | undefined;
    /** Per-domain status of a managed certificate. */
    managedDomainStatus: Record<string, string>;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    sslCertificateId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine SSL certificate for HTTPS / SSL load balancing.
 *
 * Maps to the global `sslCertificates` collection (`regionSslCertificates`
 * is a separate resource). Certificates cannot be updated in place — every
 * user-facing field is immutable and changing it replaces the resource.
 * Compute SSL certificates have no labels field, so Alchemy stamps
 * ownership into the description for `list` / nuke.
 *
 * ### Creating a Self-Managed Certificate
 * **Example:** Generated name
 * ```typescript
 * const cert = yield* GCP.Compute.SslCertificate("Frontend", {
 *   certificate: pemCertificate,
 *   privateKey: pemPrivateKey,
 * });
 * ```
 *
 * **Example:** Named certificate with a description
 * ```typescript
 * const cert = yield* GCP.Compute.SslCertificate("Frontend", {
 *   sslCertificateName: "app-frontend-tls",
 *   description: "prod frontend",
 *   certificate: pemCertificate,
 *   privateKey: pemPrivateKey,
 * });
 * ```
 *
 * ### Google-Managed Certificates
 * **Example:** Provision a managed certificate for a domain
 * ```typescript
 * const cert = yield* GCP.Compute.SslCertificate("Frontend", {
 *   type: "MANAGED",
 *   managed: { domains: ["www.example.com"] },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const SslCertificate = Resource<SslCertificate>(
  "GCP.Compute.SslCertificate",
);

export class SslCertificateNotResolved extends Data.TaggedError(
  "GCP.Compute.SslCertificateNotResolved",
)<{
  sslCertificateName: string;
}> {}

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `s${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "sslcert";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined): boolean =>
  (description ?? "").startsWith("[alchemy ");

const typeOf = (props: {
  type?: string;
  managed?: SslCertificateManaged;
  certificate?: string;
  selfManaged?: SslCertificateSelfManaged;
}): SslCertificateType => {
  if (props.type === "MANAGED" || props.type === "SELF_MANAGED") {
    return props.type;
  }
  if ((props.managed?.domains?.length ?? 0) > 0) return "MANAGED";
  return "SELF_MANAGED";
};

const asType = (type: string | undefined): SslCertificateType =>
  type === "MANAGED" ? "MANAGED" : "SELF_MANAGED";

const selfManagedOf = (props: {
  certificate?: string;
  privateKey?: string;
  selfManaged?: SslCertificateSelfManaged;
}) => ({
  certificate: props.certificate ?? props.selfManaged?.certificate,
  privateKey: props.privateKey ?? props.selfManaged?.privateKey,
});

const normalizePem = (pem: string | undefined): string =>
  (pem ?? "").replace(/\s+/g, "");

const sameDomains = (left?: readonly string[], right?: readonly string[]) =>
  [...(left ?? [])].sort().join("\0") === [...(right ?? [])].sort().join("\0");

const toBody = (
  sslCertificateName: string,
  props: SslCertificateProps,
  ownership: Record<string, string>,
): compute.SslCertificate => {
  const type = typeOf(props);
  const description = encodeDescription(ownership, props.description);
  if (type === "MANAGED") {
    return {
      name: sslCertificateName,
      description,
      type: "MANAGED",
      managed: { domains: props.managed?.domains },
    };
  }
  const material = selfManagedOf(props);
  return {
    name: sslCertificateName,
    description,
    type: "SELF_MANAGED",
    certificate: material.certificate,
    privateKey: material.privateKey,
    selfManaged: {
      certificate: material.certificate,
      privateKey: material.privateKey,
    },
  };
};

const toAttrs = (cert: compute.SslCertificate, project: string) => {
  const parsed = parseDescription(cert.description);
  return {
    sslCertificateName: cert.name ?? cert.id ?? "",
    project,
    type: asType(cert.type),
    description: parsed.description,
    certificate: cert.certificate,
    expireTime: cert.expireTime,
    subjectAlternativeNames: cert.subjectAlternativeNames ?? [],
    managedDomains: cert.managed?.domains ?? [],
    managedStatus: cert.managed?.status,
    managedDomainStatus: Object.fromEntries(
      Object.entries(cert.managed?.domainStatus ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    selfLink: cert.selfLink,
    sslCertificateId: cert.id,
    creationTimestamp: cert.creationTimestamp,
    kind: cert.kind,
  };
};

const getByName = (project: string, sslCertificate: string) =>
  compute
    .getSslCertificates({ project, sslCertificate })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, sslCertificateName: string) =>
  getByName(project, sslCertificateName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (cert) => cert !== undefined,
      times: 8,
    }),
  );

const immutableChanged = (
  news: SslCertificateProps,
  olds: Partial<SslCertificateProps> | undefined,
  output: SslCertificate["Attributes"] | undefined,
) => {
  const previousType = typeOf({
    type: olds?.type ?? output?.type,
    managed: olds?.managed ?? { domains: output?.managedDomains },
    certificate: olds?.certificate ?? output?.certificate,
    selfManaged: olds?.selfManaged,
  });
  if (typeOf(news) !== previousType) return true;

  const previousDescription = olds?.description ?? output?.description ?? "";
  if ((news.description ?? "") !== previousDescription) return true;

  if (typeOf(news) === "MANAGED") {
    const previousDomains =
      olds?.managed?.domains ?? output?.managedDomains ?? [];
    if (
      news.managed?.domains !== undefined &&
      !sameDomains(news.managed.domains, previousDomains)
    ) {
      return true;
    }
    return false;
  }

  const nextMaterial = selfManagedOf(news);
  const previousMaterial = selfManagedOf({
    certificate: olds?.certificate ?? output?.certificate,
    privateKey: olds?.privateKey,
    selfManaged: olds?.selfManaged,
  });
  if (
    nextMaterial.certificate !== undefined &&
    normalizePem(nextMaterial.certificate) !==
      normalizePem(previousMaterial.certificate)
  ) {
    return true;
  }
  if (
    nextMaterial.privateKey !== undefined &&
    previousMaterial.privateKey !== undefined &&
    normalizePem(nextMaterial.privateKey) !==
      normalizePem(previousMaterial.privateKey)
  ) {
    return true;
  }
  return false;
};

export const SslCertificateProvider = () =>
  Provider.succeed(SslCertificate, {
    stables: [
      "sslCertificateName",
      "project",
      "sslCertificateId",
      "selfLink",
      "creationTimestamp",
      "type",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.sslCertificateName ?? output?.sslCertificateName;
      const nextName = news.sslCertificateName ?? previousName;
      if (previousName === undefined && output === undefined) {
        return undefined;
      }
      const nameChanged =
        news.sslCertificateName !== undefined &&
        previousName !== undefined &&
        news.sslCertificateName !== previousName;
      if (nameChanged || immutableChanged(news, olds, output)) {
        return {
          action: "replace" as const,
          deleteFirst: nextName !== undefined && nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sslCertificateName = yield* toName(
        id,
        olds?.sslCertificateName,
        output?.sslCertificateName,
      );
      const existing = yield* getByName(env.project, sslCertificateName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listSslCertificates
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((cert) => hasOwnershipMarker(cert.description)),
            Stream.map((cert) => toAttrs(cert, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sslCertificateName = yield* toName(
        id,
        news.sslCertificateName,
        output?.sslCertificateName,
      );
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(sslCertificateName, news, ownership);

      let current = yield* getByName(env.project, sslCertificateName);

      if (current === undefined) {
        const created = yield* compute
          .insertSslCertificates({
            project: env.project,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current =
          created !== undefined
            ? yield* awaitResource(env.project, sslCertificateName)
            : yield* getByName(env.project, sslCertificateName);
      }

      if (current === undefined) {
        return yield* new SslCertificateNotResolved({ sslCertificateName });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteSslCertificates({
          project: env.project,
          sslCertificate: output.sslCertificateName,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
