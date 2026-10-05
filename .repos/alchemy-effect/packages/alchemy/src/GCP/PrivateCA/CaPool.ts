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

const DEFAULT_TIER = "DEVOPS";
const MAX_NAME_LENGTH = 63;

export type CaPoolTier = privateca.CaPoolTierEnum | (string & {});

export type PublishingOptionsEncodingFormat =
  | privateca.PublishingOptionsEncodingFormatEnum
  | (string & {});

export type PublishingOptions = {
  /**
   * When true, publishes each CA certificate and includes its URL in the
   * Authority Information Access extension of issued certificates.
   */
  publishCaCert?: boolean;
  /**
   * When true, publishes each CA CRL and includes its URL in the CRL
   * Distribution Points extension of issued certificates.
   */
  publishCrl?: boolean;
  /**
   * Encoding of published CA certificates and CRLs. `PEM` or `DER`.
   * Defaults to `PEM` when omitted.
   */
  encodingFormat?: PublishingOptionsEncodingFormat;
};

export type EncryptionSpec = {
  /**
   * Cloud KMS CryptoKey used to encrypt Subject, SubjectAltNames, and
   * PEM certificate fields at rest
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable — changing it replaces the pool.
   */
  cloudKmsKey?: string;
};

/**
 * Issuance controls applied to every certificate minted from this pool.
 * See Certificate Authority Service `IssuancePolicy`.
 */
export type IssuancePolicy = privateca.IssuancePolicy;

export type CaPoolProps = {
  /**
   * CaPool id (the `{caPool}` segment of
   * `projects/{project}/locations/{location}/caPools/{caPool}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `[a-zA-Z0-9_-]{1,63}`. Immutable — changing it
   * replaces the pool.
   */
  caPoolId?: string;
  /**
   * Certificate Authority Service location (`us-central1`, `us-east1`,
   * …). Immutable — changing it replaces the pool. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Pool tier. `DEVOPS` is cheaper and intended for tests and
   * non-production; `ENTERPRISE` enables CA-certificate and CRL
   * publication. Immutable — changing it replaces the pool.
   * @default "DEVOPS"
   */
  tier?: CaPoolTier;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * How CA certificates and CRLs are published for authorities in this
   * pool.
   */
  publishingOptions?: PublishingOptions;
  /**
   * Controls over certificate issuance from this pool (lifetime, allowed
   * key types, identity constraints, baseline X.509 values).
   */
  issuancePolicy?: IssuancePolicy;
  /**
   * Customer-managed encryption for certificate fields at rest.
   * Immutable — changing it replaces the pool.
   */
  encryptionSpec?: EncryptionSpec;
};

export type CaPool = Resource<
  "GCP.PrivateCA.CaPool",
  CaPoolProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/caPools/{caPool}`. */
    name: string;
    /** CaPool id (last path segment). */
    caPoolId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Pool tier (`DEVOPS` or `ENTERPRISE`). */
    tier: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Publishing options currently configured on the pool. */
    publishingOptions: PublishingOptions | undefined;
    /** Issuance policy currently configured on the pool. */
    issuancePolicy: IssuancePolicy | undefined;
    /** CMEK spec, if any. */
    encryptionSpec: EncryptionSpec | undefined;
  },
  never,
  Providers
>;

/**
 * A Certificate Authority Service CaPool — a group of Certificate
 * Authorities that share issuance policy and form a trust anchor.
 *
 * Changing `caPoolId`, `location`, `tier`, or `encryptionSpec` replaces
 * the resource. Labels, `publishingOptions`, and `issuancePolicy` update
 * in place.
 *
 * ### Creating a CaPool
 * **Example:** Generated name
 * ```typescript
 * const pool = yield* GCP.PrivateCA.CaPool("AppCa", {});
 * ```
 *
 * **Example:** Explicit id, labels, and publishing
 * ```typescript
 * const pool = yield* GCP.PrivateCA.CaPool("AppCa", {
 *   caPoolId: "app-ca",
 *   location: "us-central1",
 *   tier: "DEVOPS",
 *   labels: { env: "prod" },
 *   publishingOptions: {
 *     publishCaCert: false,
 *     publishCrl: false,
 *   },
 * });
 * ```
 *
 * ### Issuance Policy
 * **Example:** Cap lifetime and allow config-based issuance
 * ```typescript
 * const pool = yield* GCP.PrivateCA.CaPool("LeafCa", {
 *   tier: "DEVOPS",
 *   issuancePolicy: {
 *     maximumLifetime: "2592000s",
 *     allowedIssuanceModes: {
 *       allowConfigBasedIssuance: true,
 *       allowCsrBasedIssuance: true,
 *     },
 *     identityConstraints: {
 *       allowSubjectPassthrough: true,
 *       allowSubjectAltNamesPassthrough: true,
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category PrivateCA
 */
export const CaPool = Resource<CaPool>("GCP.PrivateCA.CaPool");

export class CaPoolNotResolved extends Data.TaggedError(
  "GCP.PrivateCA.CaPoolNotResolved",
)<{
  name: string;
}> {}

export class CaPoolStillExists extends Data.TaggedError(
  "GCP.PrivateCA.CaPoolStillExists",
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
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "ca-pool";
};

const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

const normalizeTier = (tier: string | undefined) => {
  const value = (tier ?? DEFAULT_TIER).toUpperCase();
  return value === "TIER_UNSPECIFIED" ? DEFAULT_TIER : value;
};

const resourceName = (project: string, location: string, caPoolId: string) =>
  `projects/${project}/locations/${location}/caPools/${caPoolId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const poolsAt = parts.lastIndexOf("caPools");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    caPoolId:
      poolsAt >= 0 && parts[poolsAt + 1]
        ? parts[poolsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, caPoolId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (caPoolId !== undefined) return caPoolId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

const encodingOf = (value: string | undefined) => {
  if (
    value === undefined ||
    value === "" ||
    value === "ENCODING_FORMAT_UNSPECIFIED"
  ) {
    return undefined;
  }
  return value;
};

const toPublishingOptions = (
  options: PublishingOptions | privateca.PublishingOptions | undefined,
): PublishingOptions => ({
  publishCaCert: options?.publishCaCert === true,
  publishCrl: options?.publishCrl === true,
  encodingFormat: encodingOf(options?.encodingFormat),
});

const publishingFingerprint = (
  options: PublishingOptions | privateca.PublishingOptions | undefined,
) =>
  fingerprint({
    publishCaCert: options?.publishCaCert === true,
    publishCrl: options?.publishCrl === true,
    encodingFormat: encodingOf(options?.encodingFormat) ?? "PEM",
  });

const toEncryptionSpec = (
  spec: EncryptionSpec | privateca.EncryptionSpec | undefined,
): EncryptionSpec | undefined => {
  const cloudKmsKey = spec?.cloudKmsKey;
  if (cloudKmsKey === undefined || cloudKmsKey.length === 0) return undefined;
  return { cloudKmsKey };
};

const toIssuancePolicy = (
  policy: IssuancePolicy | undefined,
): IssuancePolicy | undefined => {
  if (policy === undefined) return undefined;
  const next = canonical(policy);
  return next === undefined ? undefined : (next as IssuancePolicy);
};

const toAttrs = (pool: privateca.CaPool, project: string) => {
  const name = pool.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    caPoolId: parsed.caPoolId,
    project: parsed.project || project,
    location: parsed.location,
    tier: normalizeTier(pool.tier),
    labels: userLabels(pool.labels),
    publishingOptions: toPublishingOptions(pool.publishingOptions),
    issuancePolicy: toIssuancePolicy(pool.issuancePolicy),
    encryptionSpec: toEncryptionSpec(pool.encryptionSpec),
  };
};

const getByName = (name: string) =>
  privateca
    .getProjectsLocationsCaPools({ name })
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
    Effect.flatMap((pool) =>
      pool
        ? Effect.succeed(pool)
        : Effect.fail(new CaPoolNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.PrivateCA.CaPoolNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(new CaPoolStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.PrivateCA.CaPoolStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listOwnedCaPools = (project: string) =>
  privateca.listProjectsLocationsCaPools
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.caPools ?? [])),
      Stream.filter((pool) =>
        Object.keys(pool.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((pool) => toAttrs(pool, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateBody = (
  news: CaPoolProps,
  desiredLabels: Record<string, string>,
): privateca.CaPool => {
  const body: privateca.CaPool = {
    tier: normalizeTier(news.tier),
    labels: desiredLabels,
  };
  if (news.publishingOptions !== undefined) {
    body.publishingOptions = toPublishingOptions(news.publishingOptions);
  }
  const issuance = toIssuancePolicy(news.issuancePolicy);
  if (issuance !== undefined) {
    body.issuancePolicy = issuance;
  }
  const encryption = toEncryptionSpec(news.encryptionSpec);
  if (encryption !== undefined) {
    body.encryptionSpec = encryption;
  }
  return body;
};

export const CaPoolProvider = () =>
  Provider.succeed(CaPool, {
    stables: ["name", "caPoolId", "project", "location", "tier"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.caPoolId ?? output?.caPoolId;
      const nextId = news.caPoolId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location ?? env.region,
      );
      const locationChanged = previousLocation !== nextLocation;

      const previousTier = normalizeTier(olds?.tier ?? output?.tier);
      const nextTier = normalizeTier(news.tier ?? olds?.tier ?? output?.tier);
      const tierChanged = previousTier !== nextTier;

      const previousKey =
        olds?.encryptionSpec?.cloudKmsKey ??
        output?.encryptionSpec?.cloudKmsKey;
      const nextKey = news.encryptionSpec?.cloudKmsKey ?? previousKey;
      const encryptionChanged =
        news.encryptionSpec !== undefined && previousKey !== nextKey;

      if (
        !idChanged &&
        !locationChanged &&
        !tierChanged &&
        !encryptionChanged
      ) {
        return undefined;
      }

      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged &&
          !locationChanged &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const caPoolId = yield* toId(id, olds?.caPoolId, output?.caPoolId);
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, caPoolId);
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
        return yield* listOwnedCaPools(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const caPoolId = yield* toId(id, news.caPoolId, output?.caPoolId);
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, caPoolId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* privateca
          .createProjectsLocationsCaPools({
            parent: `projects/${env.project}/locations/${location}`,
            caPoolId,
            body: toCreateBody(news, desiredLabels),
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
        return yield* new CaPoolNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      const desiredPublishing = toPublishingOptions(news.publishingOptions);
      const publishingChanged =
        news.publishingOptions !== undefined &&
        publishingFingerprint(news.publishingOptions) !==
          publishingFingerprint(current.publishingOptions);

      const desiredIssuance = toIssuancePolicy(news.issuancePolicy);
      const issuanceChanged =
        news.issuancePolicy !== undefined &&
        fingerprint(desiredIssuance) !==
          fingerprint(toIssuancePolicy(current.issuancePolicy));

      if (labelsChanged || publishingChanged || issuanceChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          publishingChanged ? "publishingOptions" : undefined,
          issuanceChanged ? "issuancePolicy" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation = yield* privateca.patchProjectsLocationsCaPools({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            publishingOptions: desiredPublishing,
            issuancePolicy: desiredIssuance,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new CaPoolNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* privateca
        .deleteProjectsLocationsCaPools({ name: output.name })
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
