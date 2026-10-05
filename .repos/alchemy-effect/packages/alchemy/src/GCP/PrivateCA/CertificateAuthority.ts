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

const DEFAULT_TYPE: privateca.CertificateAuthorityTypeEnum = "SELF_SIGNED";
const DEFAULT_LIFETIME = "315360000s";
const DEFAULT_ALGORITHM: privateca.KeyVersionSpecAlgorithmEnum =
  "EC_P256_SHA256";
const DEFAULT_DESIRED_STATE: DesiredState = "ENABLED";
const MAX_NAME_LENGTH = 63;
const STEADY_STATES = new Set([
  "ENABLED",
  "DISABLED",
  "STAGED",
  "AWAITING_USER_ACTIVATION",
]);

export type DesiredState = "ENABLED" | "DISABLED" | "STAGED";

export type KeyVersionSpec = {
  /**
   * Algorithm for a Google-managed Cloud KMS key. Managed keys use
   * `HSM` protection. Immutable — changing it replaces the CA.
   */
  algorithm?: privateca.KeyVersionSpecAlgorithmEnum | (string & {});
  /**
   * Existing Cloud KMS CryptoKeyVersion
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}/cryptoKeyVersions/{version}`.
   * Immutable — changing it replaces the CA.
   */
  cloudKmsKeyVersion?: string;
};

export type Subject = {
  /** Common name of the subject. */
  commonName?: string;
  /** Organization of the subject. */
  organization?: string;
  /** Organizational unit of the subject. */
  organizationalUnit?: string;
  /** Locality or city of the subject. */
  locality?: string;
  /** Province, territory, or regional state of the subject. */
  province?: string;
  /** Country code of the subject. */
  countryCode?: string;
  /** Street address of the subject. */
  streetAddress?: string;
  /** Postal code of the subject. */
  postalCode?: string;
};

export type SubjectAltNames = {
  /** Fully-qualified DNS names. */
  dnsNames?: string[];
  /** RFC 3986 URIs. */
  uris?: string[];
  /** RFC 2822 email addresses. */
  emailAddresses?: string[];
  /** IPv4 or IPv6 addresses. */
  ipAddresses?: string[];
};

export type SubjectConfig = {
  /** Distinguished name fields. */
  subject?: Subject;
  /** Subject alternative names. */
  subjectAltName?: SubjectAltNames;
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
  /** High-level key uses (digital signature, cert sign, …). */
  baseKeyUsage?: KeyUsageOptions;
  /** Extended key uses (server auth, client auth, …). */
  extendedKeyUsage?: ExtendedKeyUsageOptions;
};

export type CaOptions = {
  /**
   * Whether this certificate is a CA. Must be `true` for a
   * CertificateAuthority.
   */
  isCa?: boolean;
  /**
   * Maximum depth of subordinate CA certificates allowed. Omit to leave
   * the path-length constraint off the certificate.
   */
  maxIssuerPathLength?: number;
};

export type X509Config = {
  /** CA basic-constraints options. */
  caOptions?: CaOptions;
  /** Key usage extension. */
  keyUsage?: KeyUsage;
  /** OCSP endpoints in the Authority Information Access extension. */
  aiaOcspServers?: string[];
};

export type CertificateConfig = {
  /** Subject and SAN fields written into the CA certificate. Immutable. */
  subjectConfig?: SubjectConfig;
  /** X.509 extensions written into the CA certificate. Immutable. */
  x509Config?: X509Config;
};

export type UserDefinedAccessUrls = {
  /** URLs where CRL information is published. */
  crlAccessUrls?: string[];
  /** URLs where the issuer CA certificate may be downloaded. */
  aiaIssuingCertificateUrls?: string[];
};

export type SubordinateConfig = {
  /**
   * Issuing CertificateAuthority resource name
   * `projects/{project}/locations/{location}/caPools/{caPool}/certificateAuthorities/{certificateAuthority}`.
   */
  certificateAuthority?: string;
  /** PEM certificate chain of the issuers (leaf-to-root), excluding this CA. */
  pemIssuerChain?: {
    pemCertificates?: string[];
  };
};

export type CertificateAuthorityProps = {
  /**
   * Parent CaPool. Full name
   * `projects/{project}/locations/{location}/caPools/{caPool}` or the
   * pool id (combined with `location`). Immutable — changing it replaces
   * the CA.
   */
  caPool: string;
  /**
   * Location (`us-central1`, …). Used when `caPool` is a bare id.
   * Immutable — changing it replaces the CA. `US-CENTRAL1` is accepted
   * and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * CertificateAuthority id (the last path segment). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Must match
   * `[a-zA-Z0-9_-]{1,63}`. Immutable — changing it replaces the CA.
   */
  certificateAuthorityId?: string;
  /**
   * `SELF_SIGNED` root or `SUBORDINATE`. Immutable — changing it
   * replaces the CA.
   * @default "SELF_SIGNED"
   */
  type?: privateca.CertificateAuthorityTypeEnum | (string & {});
  /**
   * Desired lifetime of the CA certificate (e.g. `"315360000s"`).
   * Immutable — changing it replaces the CA.
   * @default "315360000s"
   */
  lifetime?: string;
  /**
   * Signing key. Either `algorithm` (Google-managed HSM key) or
   * `cloudKmsKeyVersion`. Immutable — changing it replaces the CA.
   * @default { algorithm: "EC_P256_SHA256" }
   */
  keySpec?: KeyVersionSpec;
  /**
   * X.509 certificate config (subject + CA extensions). Immutable —
   * changing it replaces the CA. When omitted, Alchemy fills a self-signed
   * CA subject (`organization: "Alchemy"`, `commonName` = id) with
   * `isCa: true` and cert/CRL sign usage.
   */
  config?: CertificateConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cloud Storage bucket that publishes the CA certificate and CRLs
   * (bucket name only, no `gs://` prefix). Immutable.
   */
  gcsBucket?: string;
  /**
   * User-defined AIA/CRL URLs. The service does not publish to these
   * URLs; they are mirrored by the operator. Updatable.
   */
  userDefinedAccessUrls?: UserDefinedAccessUrls;
  /**
   * Issuer information for a subordinate CA. Updatable, but the CA must
   * continue to validate against the chain.
   */
  subordinateConfig?: SubordinateConfig;
  /**
   * PEM CA certificate used to activate a `SUBORDINATE` CA that is in
   * `AWAITING_USER_ACTIVATION`. Pair with `subordinateConfig`.
   */
  pemCaCertificate?: string;
  /**
   * Target operational state. After create the API leaves the CA in
   * `STAGED`. `ENABLED` calls enable; `DISABLED` calls disable; `STAGED`
   * leaves the create-time state (it is not possible to return to
   * `STAGED` from `ENABLED`/`DISABLED`).
   * @default "ENABLED"
   */
  desiredState?: DesiredState | (string & {});
};

export type CertificateAuthorityAttrs = {
  /** Full resource name `projects/{project}/locations/{location}/caPools/{caPool}/certificateAuthorities/{certificateAuthority}`. */
  name: string;
  /** CertificateAuthority id (last path segment). */
  certificateAuthorityId: string;
  /** Parent CaPool resource name. */
  caPool: string;
  /** Project id. */
  project: string;
  /** Location id (`us-central1`, …). */
  location: string;
  /** `SELF_SIGNED` or `SUBORDINATE`. */
  type: string;
  /** Server-reported state (`ENABLED`, `STAGED`, `DISABLED`, …). */
  state: string | undefined;
  /** CaPool tier (`ENTERPRISE`, `DEVOPS`). */
  tier: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** CA certificate lifetime. */
  lifetime: string | undefined;
  /** Signing-key spec currently applied. */
  keySpec: KeyVersionSpec | undefined;
  /** Cloud Storage bucket used for publishing, if any. */
  gcsBucket: string | undefined;
  /** PEM CA certificate chain (self-to-root). */
  pemCaCertificates: string[];
  /** User-defined AIA/CRL URLs. */
  userDefinedAccessUrls: UserDefinedAccessUrls | undefined;
  /** Subordinate issuer config, if any. */
  subordinateConfig: SubordinateConfig | undefined;
  /** URLs for the CA certificate and CRLs. */
  caCertificateUrl: string | undefined;
  /** CRL access URL. */
  crlAccessUrl: string | undefined;
  /** RFC3339 creation timestamp. */
  createTime: string | undefined;
  /** RFC3339 last-update timestamp. */
  updateTime: string | undefined;
  /** RFC3339 soft-delete timestamp, if the CA is `DELETED`. */
  deleteTime: string | undefined;
  /** RFC3339 purge timestamp, if the CA is `DELETED`. */
  expireTime: string | undefined;
};

export type CertificateAuthority = Resource<
  "GCP.PrivateCA.CertificateAuthority",
  CertificateAuthorityProps,
  CertificateAuthorityAttrs,
  never,
  Providers
>;

/**
 * A Certificate Authority Service CertificateAuthority — a named CA in a
 * CaPool that issues certificates.
 *
 * Changing `certificateAuthorityId`, `caPool`, `location`, `type`,
 * `lifetime`, `keySpec`, `config`, or `gcsBucket` replaces the CA. Labels
 * and `userDefinedAccessUrls` update in place. `desiredState` enable/disable
 * the CA after create (`STAGED` is the API's create-time state).
 *
 * Destroy disables an `ENABLED` CA, then deletes it with `skipGracePeriod`
 * so the 30-day undelete window is skipped (required for `pnpm nuke:gcp`).
 * `STAGED` CAs are deleted directly. Provisioning a Google-managed HSM key
 * typically takes under a minute on a `DEVOPS` pool.
 *
 * ### Creating a Certificate Authority
 * **Example:** Generated name in an existing pool
 * ```typescript
 * const pool = yield* GCP.PrivateCA.CaPool("Pool", { tier: "DEVOPS" });
 * const ca = yield* GCP.PrivateCA.CertificateAuthority("Root", {
 *   caPool: pool.name,
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and subject
 * ```typescript
 * const ca = yield* GCP.PrivateCA.CertificateAuthority("Root", {
 *   caPool: pool.name,
 *   certificateAuthorityId: "app-root",
 *   type: "SELF_SIGNED",
 *   lifetime: "315360000s",
 *   keySpec: { algorithm: "EC_P256_SHA256" },
 *   desiredState: "ENABLED",
 *   labels: { env: "prod" },
 *   config: {
 *     subjectConfig: {
 *       subject: {
 *         organization: "Example",
 *         commonName: "Example Root CA",
 *       },
 *     },
 *     x509Config: {
 *       caOptions: { isCa: true },
 *       keyUsage: {
 *         baseKeyUsage: {
 *           certSign: true,
 *           crlSign: true,
 *         },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Staging a CA
 * **Example:** Leave the CA in STAGED after create
 * ```typescript
 * const ca = yield* GCP.PrivateCA.CertificateAuthority("Root", {
 *   caPool: pool.name,
 *   desiredState: "STAGED",
 * });
 * ```
 *
 * @resource
 * @category PrivateCA
 */
export const CertificateAuthority = Resource<CertificateAuthority>(
  "GCP.PrivateCA.CertificateAuthority",
);

export class CertificateAuthorityNotResolved extends Data.TaggedError(
  "GCP.PrivateCA.CertificateAuthorityNotResolved",
)<{
  name: string;
}> {}

export class CertificateAuthorityNotReady extends Data.TaggedError(
  "GCP.PrivateCA.CertificateAuthorityNotReady",
)<{
  name: string;
  state: string;
}> {}

export class CertificateAuthorityStillExists extends Data.TaggedError(
  "GCP.PrivateCA.CertificateAuthorityStillExists",
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

const normalizeType = (type: string | undefined) => {
  const value = (type ?? DEFAULT_TYPE).toUpperCase();
  return value === "TYPE_UNSPECIFIED" ? DEFAULT_TYPE : value;
};

const normalizeDesired = (state: string | undefined): DesiredState => {
  const value = (state ?? DEFAULT_DESIRED_STATE).toUpperCase();
  if (value === "DISABLED") return "DISABLED";
  if (value === "STAGED") return "STAGED";
  return "ENABLED";
};

const resourceName = (caPool: string, certificateAuthorityId: string) =>
  `${caPool}/certificateAuthorities/${certificateAuthorityId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const casAt = parts.lastIndexOf("certificateAuthorities");
  const poolsAt = parts.lastIndexOf("caPools");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const caPool = poolsAt >= 0 ? parts.slice(0, poolsAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    caPool,
    certificateAuthorityId:
      casAt >= 0 && parts[casAt + 1] ? parts[casAt + 1]! : lastSegment(name),
  };
};

const resolveParent = (project: string, caPool: string, location: string) => {
  if (caPool.includes("/")) {
    const parsed = parseName(
      caPool.includes("/certificateAuthorities/")
        ? caPool
        : `${caPool}/certificateAuthorities/_`,
    );
    return {
      parent: parsed.caPool,
      location: parsed.location,
      project: parsed.project || project,
    };
  }
  const loc = normalizeLocation(location);
  return {
    parent: `projects/${project}/locations/${loc}/caPools/${caPool}`,
    location: loc,
    project,
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  certificateAuthorityId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      certificateAuthorityId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const keySpecOf = (
  spec: privateca.KeyVersionSpec | KeyVersionSpec | undefined,
): KeyVersionSpec | undefined => {
  if (spec === undefined) return undefined;
  return {
    algorithm: spec.algorithm,
    cloudKmsKeyVersion: spec.cloudKmsKeyVersion,
  };
};

const urlsOf = (
  urls: privateca.UserDefinedAccessUrls | UserDefinedAccessUrls | undefined,
): UserDefinedAccessUrls | undefined => {
  if (urls === undefined) return undefined;
  return {
    crlAccessUrls: urls.crlAccessUrls,
    aiaIssuingCertificateUrls: urls.aiaIssuingCertificateUrls,
  };
};

const subordinateOf = (
  config: privateca.SubordinateConfig | SubordinateConfig | undefined,
): SubordinateConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    certificateAuthority: config.certificateAuthority,
    pemIssuerChain:
      config.pemIssuerChain === undefined
        ? undefined
        : { pemCertificates: config.pemIssuerChain.pemCertificates },
  };
};

const toAttrs = (
  ca: privateca.CertificateAuthority,
  project: string,
): CertificateAuthorityAttrs => {
  const name = ca.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    certificateAuthorityId: parsed.certificateAuthorityId,
    caPool: parsed.caPool,
    project: parsed.project || project,
    location: parsed.location,
    type: normalizeType(ca.type),
    state: ca.state,
    tier: ca.tier,
    labels: userLabels(ca.labels),
    lifetime: ca.lifetime,
    keySpec: keySpecOf(ca.keySpec),
    gcsBucket: ca.gcsBucket,
    pemCaCertificates: ca.pemCaCertificates ?? [],
    userDefinedAccessUrls: urlsOf(ca.userDefinedAccessUrls),
    subordinateConfig: subordinateOf(ca.subordinateConfig),
    caCertificateUrl: ca.accessUrls?.caCertificateAccessUrl,
    crlAccessUrl: ca.accessUrls?.crlAccessUrls?.[0],
    createTime: ca.createTime,
    updateTime: ca.updateTime,
    deleteTime: ca.deleteTime,
    expireTime: ca.expireTime,
  };
};

const defaultConfig = (certificateAuthorityId: string): CertificateConfig => ({
  subjectConfig: {
    subject: {
      organization: "Alchemy",
      commonName: certificateAuthorityId,
    },
  },
  x509Config: {
    caOptions: { isCa: true },
    keyUsage: {
      baseKeyUsage: {
        certSign: true,
        crlSign: true,
      },
    },
  },
});

const toCreateBody = (
  news: CertificateAuthorityProps,
  certificateAuthorityId: string,
  desiredLabels: Record<string, string>,
): privateca.CertificateAuthority => {
  const config = news.config ?? defaultConfig(certificateAuthorityId);
  return {
    type: normalizeType(news.type),
    lifetime: news.lifetime ?? DEFAULT_LIFETIME,
    keySpec: {
      algorithm: news.keySpec?.algorithm ?? DEFAULT_ALGORITHM,
      cloudKmsKeyVersion: news.keySpec?.cloudKmsKeyVersion,
    },
    config: {
      subjectConfig: config.subjectConfig,
      x509Config: config.x509Config,
    },
    labels: desiredLabels,
    gcsBucket: news.gcsBucket,
    userDefinedAccessUrls: news.userDefinedAccessUrls,
    subordinateConfig: news.subordinateConfig,
  };
};

const jsonKey = (value: unknown) => JSON.stringify(value ?? null);

const keySpecKey = (spec: KeyVersionSpec | undefined) =>
  jsonKey({
    algorithm: (spec?.algorithm ?? "").toUpperCase(),
    cloudKmsKeyVersion: spec?.cloudKmsKeyVersion ?? "",
  });

const urlsKey = (urls: UserDefinedAccessUrls | undefined) =>
  jsonKey({
    crl: [...(urls?.crlAccessUrls ?? [])].sort(),
    aia: [...(urls?.aiaIssuingCertificateUrls ?? [])].sort(),
  });

const subordinateKey = (config: SubordinateConfig | undefined) =>
  jsonKey({
    certificateAuthority: config?.certificateAuthority ?? "",
    pemCertificates: [...(config?.pemIssuerChain?.pemCertificates ?? [])],
  });

const configKey = (config: CertificateConfig | undefined) => jsonKey(config);

const getByName = (name: string) =>
  privateca
    .getProjectsLocationsCaPoolsCertificateAuthorities({ name })
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
    Effect.flatMap((ca) =>
      ca
        ? Effect.succeed(ca)
        : Effect.fail(new CertificateAuthorityNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.PrivateCA.CertificateAuthorityNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilSteady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (ca): ca is privateca.CertificateAuthority => ca !== undefined,
      () => new CertificateAuthorityNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (ca) => STEADY_STATES.has((ca.state ?? "").toUpperCase()),
      (ca) =>
        new CertificateAuthorityNotReady({
          name,
          state: ca.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.PrivateCA.CertificateAuthorityNotReady" ||
        error._tag === "GCP.PrivateCA.CertificateAuthorityNotResolved",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const isGone = (ca: privateca.CertificateAuthority | undefined) =>
  ca === undefined || (ca.state ?? "").toUpperCase() === "DELETED";

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((ca) =>
      isGone(ca)
        ? Effect.void
        : Effect.fail(new CertificateAuthorityStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.PrivateCA.CertificateAuthorityStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const runOperation = (
  operation: privateca.Operation | undefined,
  options?: { notFoundOk?: boolean },
) =>
  operation === undefined
    ? Effect.void
    : waitForOperation(operation, options).pipe(Effect.asVoid);

const listOwned = (project: string) =>
  privateca.listProjectsLocationsCaPoolsCertificateAuthorities
    .pages({
      parent: `projects/${project}/locations/-/caPools/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.certificateAuthorities ?? []),
      ),
      Stream.filter(
        (ca) =>
          (ca.state ?? "").toUpperCase() !== "DELETED" &&
          Object.keys(ca.labels ?? {}).some((key) =>
            key.startsWith("alchemy-"),
          ),
      ),
      Stream.map((ca) => toAttrs(ca, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const disableIfNeeded = (current: privateca.CertificateAuthority) => {
  const name = current.name ?? "";
  const state = (current.state ?? "").toUpperCase();
  // STAGED / DISABLED / AWAITING_USER_ACTIVATION can be deleted directly.
  // Disable is only valid from ENABLED.
  if (state !== "ENABLED") {
    return Effect.succeed(current);
  }
  return privateca
    .disableProjectsLocationsCaPoolsCertificateAuthorities({
      name,
      body: { ignoreDependentResources: true },
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
      Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
      Effect.flatMap((operation) => runOperation(operation)),
      Effect.flatMap(() => waitUntilSteady(name)),
      Effect.catchTag("GCP.PrivateCA.CertificateAuthorityNotResolved", () =>
        Effect.succeed(current),
      ),
    );
};

const syncDesiredState = (
  name: string,
  current: privateca.CertificateAuthority,
  desired: DesiredState,
) => {
  const state = (current.state ?? "").toUpperCase();
  if (desired === "ENABLED" && (state === "STAGED" || state === "DISABLED")) {
    return privateca
      .enableProjectsLocationsCaPoolsCertificateAuthorities({
        name,
        body: {},
      })
      .pipe(
        Effect.flatMap((operation) => waitForOperation(operation)),
        Effect.catchTag("BadRequest", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
        Effect.flatMap(() => waitUntilSteady(name)),
      );
  }
  if (desired === "DISABLED" && (state === "STAGED" || state === "ENABLED")) {
    return privateca
      .disableProjectsLocationsCaPoolsCertificateAuthorities({
        name,
        body: { ignoreDependentResources: true },
      })
      .pipe(
        Effect.flatMap((operation) => waitForOperation(operation)),
        Effect.catchTag("BadRequest", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
        Effect.flatMap(() => waitUntilSteady(name)),
      );
  }
  return Effect.succeed(current);
};

const activateIfNeeded = (
  name: string,
  current: privateca.CertificateAuthority,
  news: CertificateAuthorityProps,
) => {
  const state = (current.state ?? "").toUpperCase();
  if (
    state !== "AWAITING_USER_ACTIVATION" ||
    news.pemCaCertificate === undefined ||
    news.subordinateConfig === undefined
  ) {
    return Effect.succeed(current);
  }
  return privateca
    .activateProjectsLocationsCaPoolsCertificateAuthorities({
      name,
      body: {
        pemCaCertificate: news.pemCaCertificate,
        subordinateConfig: news.subordinateConfig,
      },
    })
    .pipe(
      Effect.flatMap((operation) => waitForOperation(operation)),
      Effect.flatMap(() => waitUntilSteady(name)),
    );
};

const undeleteIfNeeded = (current: privateca.CertificateAuthority) => {
  const name = current.name ?? "";
  if ((current.state ?? "").toUpperCase() !== "DELETED") {
    return Effect.succeed(current);
  }
  return privateca
    .undeleteProjectsLocationsCaPoolsCertificateAuthorities({
      name,
      body: {},
    })
    .pipe(
      Effect.flatMap((operation) => waitForOperation(operation)),
      Effect.flatMap(() => waitUntilSteady(name)),
    );
};

export const CertificateAuthorityProvider = () =>
  Provider.succeed(CertificateAuthority, {
    stables: [
      "name",
      "certificateAuthorityId",
      "caPool",
      "project",
      "location",
      "type",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId =
        olds?.certificateAuthorityId ?? output?.certificateAuthorityId;
      const nextId = news.certificateAuthorityId ?? previousId;
      const previousPool = olds?.caPool ?? output?.caPool ?? "";
      const nextPool = news.caPool;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const previousType = normalizeType(olds?.type ?? output?.type);
      const nextType = normalizeType(news.type ?? output?.type);
      const previousLifetime = olds?.lifetime ?? output?.lifetime ?? "";
      const nextLifetime = news.lifetime ?? previousLifetime;
      const previousBucket = olds?.gcsBucket ?? output?.gcsBucket ?? "";
      const nextBucket = news.gcsBucket ?? previousBucket;
      const previousKey = keySpecKey(olds?.keySpec ?? output?.keySpec);
      const nextKey =
        news.keySpec === undefined ? previousKey : keySpecKey(news.keySpec);
      const configChanged =
        news.config !== undefined &&
        olds?.config !== undefined &&
        configKey(news.config) !== configKey(olds.config);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousPool !== "" && nextPool !== previousPool) ||
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousLifetime !== nextLifetime ||
        previousBucket !== nextBucket ||
        previousKey !== nextKey ||
        configChanged;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousPool === nextPool &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateAuthorityId = yield* toId(
        id,
        olds?.certificateAuthorityId,
        output?.certificateAuthorityId,
      );
      const { parent } = resolveParent(
        env.project,
        olds?.caPool ?? output?.caPool ?? "",
        olds?.location ?? output?.location ?? env.region,
      );
      const name = output?.name ?? resourceName(parent, certificateAuthorityId);
      if (name.endsWith("/certificateAuthorities/") || name.endsWith("/_")) {
        return undefined;
      }
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      if ((existing.state ?? "").toUpperCase() === "DELETED") {
        return undefined;
      }
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateAuthorityId = yield* toId(
        id,
        news.certificateAuthorityId,
        output?.certificateAuthorityId,
      );
      const { parent, project } = resolveParent(
        env.project,
        news.caPool,
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(parent, certificateAuthorityId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredState = normalizeDesired(news.desiredState);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* privateca
          .createProjectsLocationsCaPoolsCertificateAuthorities({
            parent,
            certificateAuthorityId,
            body: toCreateBody(news, certificateAuthorityId, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        yield* runOperation(created);
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new CertificateAuthorityNotResolved({ name });
      }

      current = yield* undeleteIfNeeded(current);

      if (!STEADY_STATES.has((current.state ?? "").toUpperCase())) {
        current = yield* waitUntilSteady(name);
      }

      current = yield* activateIfNeeded(name, current, news);

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const urlsChanged =
        news.userDefinedAccessUrls !== undefined &&
        urlsKey(urlsOf(current.userDefinedAccessUrls)) !==
          urlsKey(news.userDefinedAccessUrls);
      const subordinateChanged =
        news.subordinateConfig !== undefined &&
        subordinateKey(subordinateOf(current.subordinateConfig)) !==
          subordinateKey(news.subordinateConfig);

      if (labelsChanged || urlsChanged || subordinateChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          urlsChanged ? "userDefinedAccessUrls" : undefined,
          subordinateChanged ? "subordinateConfig" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* privateca
          .patchProjectsLocationsCaPoolsCertificateAuthorities({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              userDefinedAccessUrls: news.userDefinedAccessUrls,
              subordinateConfig: news.subordinateConfig,
            },
          })
          .pipe(Effect.catchTag("BadRequest", () => Effect.succeed(undefined)));
        yield* runOperation(patched);
        current = yield* waitUntilSteady(name);
      }

      current = yield* syncDesiredState(name, current, desiredState);

      return toAttrs(current, project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      const existing = yield* getByName(name);
      if (existing === undefined) return;

      if ((existing.state ?? "").toUpperCase() !== "DELETED") {
        yield* disableIfNeeded(existing);
        const operation = yield* privateca
          .deleteProjectsLocationsCaPoolsCertificateAuthorities({
            name,
            skipGracePeriod: true,
            ignoreActiveCertificates: true,
            ignoreDependentResources: true,
          })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        yield* runOperation(operation, { notFoundOk: true });
      }

      yield* waitUntilGone(name);
    }),
  });
