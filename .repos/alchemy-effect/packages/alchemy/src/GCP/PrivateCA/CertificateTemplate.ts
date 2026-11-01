import * as privateca from "@distilled.cloud/gcp/privateca_v1";
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
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

/** CEL expression used to validate a certificate Subject / SAN. */
export type CelExpression = {
  /** CEL text. */
  expression?: string;
  /** Short title shown in UIs. */
  title?: string;
  /** Longer description of the expression. */
  description?: string;
  /** Source location used in error reporting. */
  location?: string;
};

/**
 * Constraints on identities that may appear in certificates issued with
 * this template. When set, both passthrough flags are required by the API.
 */
export type CertificateIdentityConstraints = {
  /**
   * Copy the requested Subject into the issued certificate.
   */
  allowSubjectPassthrough?: boolean;
  /**
   * Copy the requested Subject Alternative Names into the issued
   * certificate.
   */
  allowSubjectAltNamesPassthrough?: boolean;
  /** Optional CEL expression evaluated against the resolved identity. */
  celExpression?: CelExpression;
};

export type KnownCertificateExtension =
  | "KNOWN_CERTIFICATE_EXTENSION_UNSPECIFIED"
  | "BASE_KEY_USAGE"
  | "EXTENDED_KEY_USAGE"
  | "CA_OPTIONS"
  | "POLICY_IDS"
  | "AIA_OCSP_SERVERS"
  | "NAME_CONSTRAINTS";

export type ObjectId = {
  /** OID path, most significant component first (e.g. `[1, 3, 6, 1]`). */
  objectIdPath?: number[];
};

/** X.509 extensions that may be copied from a certificate request. */
export type CertificateExtensionConstraints = {
  /** Named X.509 extensions that may appear on issued certificates. */
  knownExtensions?: Array<KnownCertificateExtension | (string & {})>;
  /** Custom extension OIDs that may appear on issued certificates. */
  additionalExtensions?: ObjectId[];
};

export type KeyUsageOptions = {
  digitalSignature?: boolean;
  contentCommitment?: boolean;
  keyEncipherment?: boolean;
  dataEncipherment?: boolean;
  keyAgreement?: boolean;
  certSign?: boolean;
  crlSign?: boolean;
  encipherOnly?: boolean;
  decipherOnly?: boolean;
};

export type ExtendedKeyUsageOptions = {
  serverAuth?: boolean;
  clientAuth?: boolean;
  codeSigning?: boolean;
  emailProtection?: boolean;
  timeStamping?: boolean;
  ocspSigning?: boolean;
};

export type KeyUsage = {
  baseKeyUsage?: KeyUsageOptions;
  extendedKeyUsage?: ExtendedKeyUsageOptions;
  unknownExtendedKeyUsages?: ObjectId[];
};

export type CaOptions = {
  /** When missing, the basic-constraints extension is omitted. */
  isCa?: boolean;
  /** Depth of allowed subordinate CAs. Omitted when unset. */
  maxIssuerPathLength?: number;
};

export type NameConstraints = {
  critical?: boolean;
  permittedDnsNames?: string[];
  excludedDnsNames?: string[];
  permittedIpRanges?: string[];
  excludedIpRanges?: string[];
  permittedEmailAddresses?: string[];
  excludedEmailAddresses?: string[];
  permittedUris?: string[];
  excludedUris?: string[];
};

export type X509Extension = {
  objectId?: ObjectId;
  critical?: boolean;
  /** Base64-encoded extension value. */
  value?: string;
};

/** X.509 values applied to every certificate issued with this template. */
export type X509Parameters = {
  keyUsage?: KeyUsage;
  caOptions?: CaOptions;
  policyIds?: ObjectId[];
  aiaOcspServers?: string[];
  nameConstraints?: NameConstraints;
  additionalExtensions?: X509Extension[];
};

export type CertificateTemplateProps = {
  /**
   * Template id (the `{certificateTemplate}` segment of
   * `projects/{project}/locations/{location}/certificateTemplates/{certificateTemplate}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `[a-zA-Z0-9_-]{1,63}`. Immutable — changing it
   * replaces the template.
   */
  certificateTemplateId?: string;
  /**
   * Location of the template (`us-central1`, …). Immutable — changing it
   * replaces the template. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description of scenarios this template is intended for.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Maximum lifetime allowed for issued certificates (e.g. `"86400s"`).
   * The issuing CaPool may shorten this further.
   */
  maximumLifetime?: string;
  /**
   * Constraints on identities that may appear in issued certificates.
   * When set, `allowSubjectPassthrough` and
   * `allowSubjectAltNamesPassthrough` are required.
   */
  identityConstraints?: CertificateIdentityConstraints;
  /**
   * X.509 extensions that may appear on certificates issued with this
   * template. Extensions outside this set are dropped (except those in
   * `predefinedValues`).
   */
  passthroughExtensions?: CertificateExtensionConstraints;
  /**
   * X.509 values applied to every certificate issued with this template.
   * Conflicting values in the request are overwritten.
   */
  predefinedValues?: X509Parameters;
};

export type CertificateTemplate = Resource<
  "GCP.PrivateCA.CertificateTemplate",
  CertificateTemplateProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/certificateTemplates/{certificateTemplate}`. */
    name: string;
    /** Template id (last path segment). */
    certificateTemplateId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Maximum lifetime of issued certificates. */
    maximumLifetime: string | undefined;
    /** Identity constraints applied at issuance. */
    identityConstraints: CertificateIdentityConstraints | undefined;
    /** Allowed X.509 extensions. */
    passthroughExtensions: CertificateExtensionConstraints | undefined;
    /** Predefined X.509 values. */
    predefinedValues: X509Parameters | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Certificate Authority Service certificate template — reusable issuance
 * policy (identity constraints, X.509 defaults, and allowed extensions)
 * applied when issuing certificates from a CaPool.
 *
 * Changing `certificateTemplateId` or `location` replaces the template.
 * Description, labels, lifetime, identity constraints, passthrough
 * extensions, and predefined X.509 values update in place.
 *
 * ### Creating a Certificate Template
 * **Example:** Generated name
 * ```typescript
 * const template = yield* GCP.PrivateCA.CertificateTemplate("LeafTls", {
 *   description: "leaf TLS certificates",
 *   identityConstraints: {
 *     allowSubjectPassthrough: true,
 *     allowSubjectAltNamesPassthrough: true,
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id, lifetime, and labels
 * ```typescript
 * const template = yield* GCP.PrivateCA.CertificateTemplate("LeafTls", {
 *   certificateTemplateId: "leaf-tls",
 *   location: "us-central1",
 *   description: "leaf TLS certificates",
 *   maximumLifetime: "86400s",
 *   labels: { env: "prod" },
 *   identityConstraints: {
 *     allowSubjectPassthrough: true,
 *     allowSubjectAltNamesPassthrough: true,
 *   },
 *   passthroughExtensions: {
 *     knownExtensions: ["EXTENDED_KEY_USAGE"],
 *   },
 *   predefinedValues: {
 *     caOptions: { isCa: false },
 *     keyUsage: {
 *       baseKeyUsage: {
 *         digitalSignature: true,
 *         keyEncipherment: true,
 *       },
 *       extendedKeyUsage: { serverAuth: true },
 *     },
 *   },
 * });
 * ```
 *
 * ### Updating a Certificate Template
 * **Example:** Description, labels, and lifetime
 * ```typescript
 * const template = yield* GCP.PrivateCA.CertificateTemplate("LeafTls", {
 *   certificateTemplateId: "leaf-tls",
 *   description: "leaf TLS certificates v2",
 *   maximumLifetime: "172800s",
 *   labels: { env: "prod", role: "tls" },
 *   identityConstraints: {
 *     allowSubjectPassthrough: true,
 *     allowSubjectAltNamesPassthrough: false,
 *   },
 * });
 * ```
 *
 * @resource
 * @category PrivateCA
 */
export const CertificateTemplate = Resource<CertificateTemplate>(
  "GCP.PrivateCA.CertificateTemplate",
);

export class CertificateTemplateNotResolved extends Data.TaggedError(
  "GCP.PrivateCA.CertificateTemplateNotResolved",
)<{
  name: string;
}> {}

export class CertificateTemplateStillExists extends Data.TaggedError(
  "GCP.PrivateCA.CertificateTemplateStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

const resourceName = (
  project: string,
  location: string,
  certificateTemplateId: string,
) =>
  `projects/${project}/locations/${location}/certificateTemplates/${certificateTemplateId}`;

const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const templatesAt = parts.lastIndexOf("certificateTemplates");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    certificateTemplateId:
      templatesAt >= 0 && parts[templatesAt + 1]
        ? parts[templatesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  certificateTemplateId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      certificateTemplateId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const toObjectId = (value: privateca.ObjectId | ObjectId | undefined) =>
  value === undefined
    ? undefined
    : { objectIdPath: value.objectIdPath ?? undefined };

const toObjectIds = (
  values: ReadonlyArray<privateca.ObjectId | ObjectId> | undefined,
): ObjectId[] | undefined => {
  if (values === undefined) return undefined;
  return values.map((value) => toObjectId(value) ?? {});
};

const toCelExpression = (
  value: privateca.Expr | CelExpression | undefined,
): CelExpression | undefined => {
  if (value === undefined) return undefined;
  if (
    value.expression === undefined &&
    value.title === undefined &&
    value.description === undefined &&
    value.location === undefined
  ) {
    return undefined;
  }
  return {
    expression: value.expression,
    title: value.title,
    description: value.description,
    location: value.location,
  };
};

const toIdentityConstraints = (
  value:
    | privateca.CertificateIdentityConstraints
    | CertificateIdentityConstraints
    | undefined,
): CertificateIdentityConstraints | undefined => {
  if (value === undefined) return undefined;
  return {
    allowSubjectPassthrough: value.allowSubjectPassthrough,
    allowSubjectAltNamesPassthrough: value.allowSubjectAltNamesPassthrough,
    celExpression: toCelExpression(value.celExpression),
  };
};

const toPassthroughExtensions = (
  value:
    | privateca.CertificateExtensionConstraints
    | CertificateExtensionConstraints
    | undefined,
): CertificateExtensionConstraints | undefined => {
  if (value === undefined) return undefined;
  return {
    knownExtensions: value.knownExtensions,
    additionalExtensions: toObjectIds(value.additionalExtensions),
  };
};

const toKeyUsage = (
  value: privateca.KeyUsage | KeyUsage | undefined,
): KeyUsage | undefined => {
  if (value === undefined) return undefined;
  return {
    baseKeyUsage: value.baseKeyUsage,
    extendedKeyUsage: value.extendedKeyUsage,
    unknownExtendedKeyUsages: toObjectIds(value.unknownExtendedKeyUsages),
  };
};

const toNameConstraints = (
  value: privateca.NameConstraints | NameConstraints | undefined,
): NameConstraints | undefined => {
  if (value === undefined) return undefined;
  return {
    critical: value.critical,
    permittedDnsNames: value.permittedDnsNames,
    excludedDnsNames: value.excludedDnsNames,
    permittedIpRanges: value.permittedIpRanges,
    excludedIpRanges: value.excludedIpRanges,
    permittedEmailAddresses: value.permittedEmailAddresses,
    excludedEmailAddresses: value.excludedEmailAddresses,
    permittedUris: value.permittedUris,
    excludedUris: value.excludedUris,
  };
};

const toX509Extension = (
  value: privateca.X509Extension | X509Extension,
): X509Extension => ({
  objectId: toObjectId(value.objectId),
  critical: value.critical,
  value: value.value,
});

const toPredefinedValues = (
  value: privateca.X509Parameters | X509Parameters | undefined,
): X509Parameters | undefined => {
  if (value === undefined) return undefined;
  return {
    keyUsage: toKeyUsage(value.keyUsage),
    caOptions: value.caOptions
      ? {
          isCa: value.caOptions.isCa,
          maxIssuerPathLength: value.caOptions.maxIssuerPathLength,
        }
      : undefined,
    policyIds: toObjectIds(value.policyIds),
    aiaOcspServers: value.aiaOcspServers,
    nameConstraints: toNameConstraints(value.nameConstraints),
    additionalExtensions: value.additionalExtensions?.map(toX509Extension),
  };
};

const stable = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
};

const fingerprint = (value: unknown) => JSON.stringify(stable(value));

const toAttrs = (template: privateca.CertificateTemplate, project: string) => {
  const name = template.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    certificateTemplateId: parsed.certificateTemplateId,
    project: parsed.project || project,
    location: parsed.location,
    description: template.description,
    labels: userLabels(template.labels),
    maximumLifetime: template.maximumLifetime,
    identityConstraints: toIdentityConstraints(template.identityConstraints),
    passthroughExtensions: toPassthroughExtensions(
      template.passthroughExtensions,
    ),
    predefinedValues: toPredefinedValues(template.predefinedValues),
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const desiredBody = (
  news: CertificateTemplateProps,
  desiredLabels: Record<string, string>,
): privateca.CertificateTemplate => ({
  description: news.description,
  labels: desiredLabels,
  maximumLifetime: news.maximumLifetime,
  identityConstraints: news.identityConstraints,
  passthroughExtensions: news.passthroughExtensions,
  predefinedValues: news.predefinedValues,
});

const getByName = (name: string) =>
  privateca
    .getProjectsLocationsCertificateTemplates({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Wait for a Certificate Authority Service operation; CA creation and
 * activation take a few minutes. ALREADY_EXISTS (code 6) counts as success
 * (create race); with `notFoundOk`, so does NOT_FOUND (code 5, delete race)
 * and an operation that is already gone.
 */
const waitForOperation = (
  operation: privateca.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) => privateca.getProjectsLocationsOperations({ name }),
    { budget: "15 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 ||
            (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((template) =>
      template
        ? Effect.succeed(template)
        : Effect.fail(new CertificateTemplateNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.PrivateCA.CertificateTemplateNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((template) =>
      template === undefined
        ? Effect.void
        : Effect.fail(new CertificateTemplateStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.PrivateCA.CertificateTemplateStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedTemplates = (project: string) =>
  privateca.listProjectsLocationsCertificateTemplates
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.certificateTemplates ?? []),
      ),
      Stream.filter((template) =>
        Object.keys(template.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((template) => toAttrs(template, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const CertificateTemplateProvider = () =>
  Provider.succeed(CertificateTemplate, {
    stables: [
      "name",
      "certificateTemplateId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId =
        olds?.certificateTemplateId ?? output?.certificateTemplateId;
      const nextId = news.certificateTemplateId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location ?? env.region,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation;

      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateTemplateId = yield* toId(
        id,
        olds?.certificateTemplateId,
        output?.certificateTemplateId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, certificateTemplateId);
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
        return yield* listOwnedTemplates(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateTemplateId = yield* toId(
        id,
        news.certificateTemplateId,
        output?.certificateTemplateId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, certificateTemplateId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const body = desiredBody(news, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* privateca
          .createProjectsLocationsCertificateTemplates({
            parent: locationParent(env.project, location),
            certificateTemplateId,
            body,
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
        return yield* new CertificateTemplateNotResolved({ name });
      }

      const observed = toAttrs(current, env.project);
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (observed.description ?? "") !== (news.description ?? "");
      const lifetimeChanged =
        (observed.maximumLifetime ?? "") !== (news.maximumLifetime ?? "");
      const identityChanged =
        fingerprint(observed.identityConstraints) !==
        fingerprint(toIdentityConstraints(news.identityConstraints));
      const passthroughChanged =
        fingerprint(observed.passthroughExtensions) !==
        fingerprint(toPassthroughExtensions(news.passthroughExtensions));
      const predefinedChanged =
        fingerprint(observed.predefinedValues) !==
        fingerprint(toPredefinedValues(news.predefinedValues));

      if (
        labelsChanged ||
        descriptionChanged ||
        lifetimeChanged ||
        identityChanged ||
        passthroughChanged ||
        predefinedChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          lifetimeChanged ? "maximumLifetime" : undefined,
          identityChanged ? "identityConstraints" : undefined,
          passthroughChanged ? "passthroughExtensions" : undefined,
          predefinedChanged ? "predefinedValues" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* privateca.patchProjectsLocationsCertificateTemplates({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              ...body,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* privateca
        .deleteProjectsLocationsCertificateTemplates({ name: output.name })
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
