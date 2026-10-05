import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import {
  type OperationFailed,
  type OperationTimedOut,
  waitForOperation as waitForGcpOperation,
} from "../Operation.ts";
import { deterministicKmsId } from "./internal.ts";

const DEFAULT_PURPOSE: kms.CryptoKeyPurposeEnum = "ENCRYPT_DECRYPT";
const DEFAULT_ALGORITHM: kms.CryptoKeyVersionTemplateAlgorithmEnum =
  "GOOGLE_SYMMETRIC_ENCRYPTION";
const DEFAULT_PROTECTION: kms.CryptoKeyVersionTemplateProtectionLevelEnum =
  "SOFTWARE";
const DELETABLE_VERSION_STATES = new Set([
  "DESTROYED",
  "IMPORT_FAILED",
  "GENERATION_FAILED",
]);
const DESTROYABLE_VERSION_STATES = new Set(["ENABLED", "DISABLED"]);
const USABLE_VERSION_STATES = new Set(["ENABLED", "PENDING_GENERATION"]);

/**
 * Cloud KMS never deletes a key while any version is merely
 * `DESTROY_SCHEDULED` (at least 24h), never deletes a key ring, and
 * retires a deleted key's name forever. On delete Alchemy therefore never
 * deletes the key: it destroys every version and replaces the ownership
 * labels with this marker. A released key holds no usable key material, so
 * any stack may reclaim it on create: reconcile re-stamps ownership and
 * mints a fresh primary. This keeps both fixed and default (deterministic)
 * `cryptoKeyId`s reusable across destroy/redeploy cycles.
 */
export const RELEASED_LABEL = "alchemy-released";

const isReleased = (key: kms.CryptoKey) =>
  (key.labels ?? {})[RELEASED_LABEL] !== undefined;

export type CryptoKeyVersionTemplate = {
  /**
   * Algorithm for new versions. Defaults to `GOOGLE_SYMMETRIC_ENCRYPTION`
   * when `purpose` is `ENCRYPT_DECRYPT`.
   */
  algorithm?: kms.CryptoKeyVersionTemplateAlgorithmEnum | (string & {});
  /**
   * Protection level for new versions. Immutable — changing it replaces
   * the key.
   * @default "SOFTWARE"
   */
  protectionLevel?:
    | kms.CryptoKeyVersionTemplateProtectionLevelEnum
    | (string & {});
};

export type CryptoKeyProps = {
  /**
   * Parent KeyRing. Full name
   * `projects/{project}/locations/{location}/keyRings/{keyRing}` or the
   * key ring id (combined with `location`). Immutable — changing it
   * replaces the key.
   */
  keyRing: string;
  /**
   * Cloud KMS location (`us-central1`, `global`, `us`, …). Used when
   * `keyRing` is a bare id. Immutable — changing it replaces the key.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * CryptoKey id (the last path segment). If omitted, a deterministic
   * name `{stack}-{id}-{stage}` is derived (no random suffix), plus a short
   * hash of `purpose`, `versionTemplate.protectionLevel`, `importOnly`,
   * `destroyScheduledDuration`, and `cryptoKeyBackend` when any differ
   * from their defaults — so a redeploy after destroy reclaims the same
   * key, and a replacement caused by those settings gets a distinct name.
   * Must match `[a-zA-Z0-9_-]{1,63}`. Immutable — changing it replaces the
   * key.
   */
  cryptoKeyId?: string;
  /**
   * Immutable purpose of this key.
   * @default "ENCRYPT_DECRYPT"
   */
  purpose?: kms.CryptoKeyPurposeEnum;
  /**
   * Template for new CryptoKeyVersions. `protectionLevel` is immutable
   * (replacement); `algorithm` can be patched.
   */
  versionTemplate?: CryptoKeyVersionTemplate;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Automatic rotation period (e.g. `"2592000s"`). ENCRYPT_DECRYPT keys
   * only. Must be paired with `nextRotationTime` (Alchemy fills
   * `now + period` when omitted).
   */
  rotationPeriod?: string;
  /**
   * RFC3339 time of the next automatic rotation. ENCRYPT_DECRYPT keys
   * only.
   */
  nextRotationTime?: string;
  /**
   * How long versions stay in `DESTROY_SCHEDULED` before `DESTROYED`.
   * Immutable. Minimum 24h except import-only keys.
   */
  destroyScheduledDuration?: string;
  /**
   * Create the key with no versions (and keep it version-less when a
   * released key is reclaimed), e.g. for import-only or externally
   * managed material.
   * @default false
   */
  skipInitialVersionCreation?: boolean;
  /**
   * Whether this key may contain imported versions only. Immutable.
   * @default false
   */
  importOnly?: boolean;
  /**
   * Backend for EXTERNAL_VPC / HSM_SINGLE_TENANT keys. Immutable.
   */
  cryptoKeyBackend?: string;
};

export type CryptoKeyAttrs = {
  /** Full resource name `projects/.../cryptoKeys/{cryptoKey}`. */
  name: string;
  /** CryptoKey id (last path segment). */
  cryptoKeyId: string;
  /** Parent KeyRing resource name. */
  keyRing: string;
  /** Location id (`us-central1`, `global`, …). */
  location: string;
  /** Project id. */
  project: string;
  /** Key purpose. */
  purpose: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Version template currently applied. */
  versionTemplate: CryptoKeyVersionTemplate | undefined;
  /** Automatic rotation period, if set. */
  rotationPeriod: string | undefined;
  /** Next automatic rotation time, if set. */
  nextRotationTime: string | undefined;
  /** Scheduled-destruction duration. */
  destroyScheduledDuration: string | undefined;
  /** Whether the key is import-only. */
  importOnly: boolean;
  /** External / single-tenant HSM backend, if any. */
  cryptoKeyBackend: string | undefined;
  /** Primary version resource name, if any. */
  primaryVersion: string | undefined;
  /** RFC3339 creation timestamp. */
  createTime: string | undefined;
};

export type CryptoKey = Resource<
  "GCP.KMS.CryptoKey",
  CryptoKeyProps,
  CryptoKeyAttrs,
  never,
  Providers
>;

/**
 * A Cloud KMS CryptoKey — a named key that holds zero or more versions.
 *
 * Purpose, location, parent KeyRing, import-only, backend,
 * `destroyScheduledDuration`, and `versionTemplate.protectionLevel` are
 * immutable (changing them replaces the key). Labels, rotation, and
 * `versionTemplate.algorithm` update in place.
 *
 * Cloud KMS only permanently deletes a CryptoKey after every version is
 * gone, and a deleted CryptoKey's name is retired forever — it can never
 * be created again in the project.
 *
 * Destroying a key therefore *releases* it instead of deleting it: every
 * version is scheduled for destruction and the ownership labels are
 * replaced by `alchemy-released`. A later deploy with the same
 * `cryptoKeyId` — from this stack or any other — reclaims the released key
 * and mints a fresh primary version. The default `cryptoKeyId` is
 * deterministic per stack, stage, and logical id, so destroy/redeploy
 * cycles reuse one key rather than leaving a new released key behind each
 * time. Ciphertext encrypted under the old versions is not recoverable.
 *
 * ### Creating a CryptoKey
 * **Example:** Generated name on an existing KeyRing
 * ```typescript
 * const ring = yield* GCP.KMS.KeyRing("Keys", {});
 * const key = yield* GCP.KMS.CryptoKey("Data", {
 *   keyRing: ring.name,
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and no initial version
 * ```typescript
 * const key = yield* GCP.KMS.CryptoKey("Data", {
 *   keyRing: ring.name,
 *   cryptoKeyId: "app-data",
 *   labels: { env: "prod" },
 *   skipInitialVersionCreation: true,
 * });
 * ```
 *
 * ### Encrypting and Decrypting
 * **Example:** Encrypt then decrypt
 * ```typescript
 * const encrypt = yield* GCP.KMS.Encrypt(key);
 * const decrypt = yield* GCP.KMS.Decrypt(key);
 * const { ciphertext } = yield* encrypt({
 *   body: { plaintext: btoa("hello") },
 * });
 * const { plaintext } = yield* decrypt({
 *   body: { ciphertext },
 * });
 * ```
 *
 * @resource
 * @category KMS
 */
export const CryptoKey = Resource<CryptoKey>("GCP.KMS.CryptoKey");

export class CryptoKeyNotResolved extends Data.TaggedError(
  "GCP.KMS.CryptoKeyNotResolved",
)<{
  name: string;
}> {}

export class CryptoKeyOperationFailed extends Data.TaggedError(
  "GCP.KMS.CryptoKeyOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class CryptoKeyVersionPending extends Data.TaggedError(
  "GCP.KMS.CryptoKeyVersionPending",
)<{
  name: string;
  state: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const normalizeProtection = (
  value: string | undefined,
): kms.CryptoKeyVersionTemplateProtectionLevelEnum =>
  !value || value === "PROTECTION_LEVEL_UNSPECIFIED"
    ? DEFAULT_PROTECTION
    : (value as kms.CryptoKeyVersionTemplateProtectionLevelEnum);

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const cryptoKeysAt = parts.lastIndexOf("cryptoKeys");
  const keyRingsAt = parts.lastIndexOf("keyRings");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const keyRing =
    keyRingsAt >= 0 ? parts.slice(0, keyRingsAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    keyRing,
    cryptoKeyId:
      cryptoKeysAt >= 0 && parts[cryptoKeysAt + 1]
        ? parts[cryptoKeysAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  keyRing: string,
  location: string | undefined,
  region: string,
) => {
  if (keyRing.includes("/")) {
    const parsed = parseName(
      keyRing.includes("/cryptoKeys/") ? keyRing : `${keyRing}/cryptoKeys/_`,
      region,
    );
    return {
      parent: parsed.keyRing,
      location: parsed.location,
      project: parsed.project || project,
    };
  }
  const loc = normalizeLocation(location, region);
  return {
    parent: `projects/${project}/locations/${loc}/keyRings/${keyRing}`,
    location: loc,
    project,
  };
};

const resourceName = (parent: string, cryptoKeyId: string) =>
  `${parent}/cryptoKeys/${cryptoKeyId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

type ImmutableKeyProps = Pick<
  CryptoKeyProps,
  | "purpose"
  | "versionTemplate"
  | "importOnly"
  | "destroyScheduledDuration"
  | "cryptoKeyBackend"
>;

/**
 * The replacement-triggering settings (besides id and parent) folded into
 * the generated id, or `undefined` when all are defaults so the common
 * case keeps the plain `{stack}-{id}-{stage}` name.
 */
const immutableVariant = (props: ImmutableKeyProps | undefined) => {
  const purpose = props?.purpose ?? DEFAULT_PURPOSE;
  const protectionLevel = normalizeProtection(
    props?.versionTemplate?.protectionLevel,
  );
  const importOnly = props?.importOnly === true;
  const destroyScheduledDuration = props?.destroyScheduledDuration;
  const cryptoKeyBackend = props?.cryptoKeyBackend || undefined;
  if (
    purpose === DEFAULT_PURPOSE &&
    protectionLevel === DEFAULT_PROTECTION &&
    !importOnly &&
    destroyScheduledDuration === undefined &&
    cryptoKeyBackend === undefined
  ) {
    return undefined;
  }
  return {
    purpose,
    protectionLevel,
    importOnly,
    destroyScheduledDuration,
    cryptoKeyBackend,
  };
};

const toId = (
  id: string,
  props: (ImmutableKeyProps & { cryptoKeyId?: string }) | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      props?.cryptoKeyId ??
      existing ??
      (yield* deterministicKmsId(id, immutableVariant(props)))
    );
  });

const toAttrs = (
  key: kms.CryptoKey,
  project: string,
  region: string,
): CryptoKeyAttrs => {
  const name = key.name ?? "";
  const parsed = parseName(name, region);
  const template = key.versionTemplate;
  return {
    name,
    cryptoKeyId: parsed.cryptoKeyId,
    keyRing: parsed.keyRing,
    location: parsed.location,
    project: parsed.project || project,
    purpose: key.purpose ?? DEFAULT_PURPOSE,
    labels: userLabels(key.labels),
    versionTemplate:
      template === undefined
        ? undefined
        : {
            algorithm: template.algorithm,
            protectionLevel: template.protectionLevel,
          },
    rotationPeriod: key.rotationPeriod,
    nextRotationTime: key.nextRotationTime,
    destroyScheduledDuration: key.destroyScheduledDuration,
    importOnly: key.importOnly === true,
    cryptoKeyBackend: key.cryptoKeyBackend,
    primaryVersion: key.primary?.name,
    createTime: key.createTime,
  };
};

const getByName = (name: string) =>
  kms
    .getProjectsLocationsKeyRingsCryptoKeys({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const paginate = <A, E, R>(
  fetch: (
    pageToken: string | undefined,
  ) => Effect.Effect<{ items: A[]; nextPageToken?: string }, E, R>,
) =>
  Effect.gen(function* () {
    const found: A[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* fetch(pageToken);
      found.push(...response.items);
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  });

const listKeyRingsAt = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRings({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.keyRings ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.KeyRing[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listKeysInRing = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRingsCryptoKeys({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          // Released keys hold no key material and belong to no stack.
          items: (response.cryptoKeys ?? []).filter(
            (key) =>
              !isReleased(key) &&
              Object.keys(key.labels ?? {}).some((label) =>
                label.startsWith("alchemy-"),
              ),
          ),
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.CryptoKey[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listCryptoKeysAt = (locationParent: string) =>
  Effect.gen(function* () {
    const rings = yield* listKeyRingsAt(locationParent);
    const pages = yield* Effect.forEach(
      rings,
      (ring) =>
        ring.name
          ? listKeysInRing(ring.name)
          : Effect.succeed([] as kms.CryptoKey[]),
      { concurrency: 4 },
    );
    return pages.flat();
  });

const listVersions = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.cryptoKeyVersions ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.CryptoKeyVersion[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const waitOperation = (operation: kms.Operation) =>
  waitForGcpOperation(
    operation,
    (name) => kms.getProjectsLocationsOperations({ name }),
    { budget: "10 minutes" },
  ).pipe(
    // Re-read the finished operation for its typed response.
    Effect.flatMap(() =>
      operation.name === undefined
        ? Effect.succeed(operation)
        : kms.getProjectsLocationsOperations({ name: operation.name }),
    ),
  );

const waitPrimaryReady = (
  name: string,
): Effect.Effect<
  kms.CryptoKey,
  | CryptoKeyNotResolved
  | CryptoKeyOperationFailed
  | CryptoKeyVersionPending
  | kms.GetProjectsLocationsKeyRingsCryptoKeysError,
  kms.GcpOpContext
> => {
  const probe: Effect.Effect<
    kms.CryptoKey,
    | CryptoKeyNotResolved
    | CryptoKeyOperationFailed
    | CryptoKeyVersionPending
    | kms.GetProjectsLocationsKeyRingsCryptoKeysError,
    kms.GcpOpContext
  > = getByName(name).pipe(
    Effect.flatMap(
      (
        key,
      ): Effect.Effect<
        kms.CryptoKey,
        | CryptoKeyNotResolved
        | CryptoKeyOperationFailed
        | CryptoKeyVersionPending
      > => {
        if (key === undefined) {
          return Effect.fail(new CryptoKeyNotResolved({ name }));
        }
        const state = key.primary?.state;
        if (state === undefined || state === "ENABLED") {
          return Effect.succeed(key);
        }
        if (state === "GENERATION_FAILED") {
          return Effect.fail(
            new CryptoKeyOperationFailed({
              operation: key.primary?.name ?? name,
              message: key.primary?.generationFailureReason ?? state,
            }),
          );
        }
        return Effect.fail(
          new CryptoKeyVersionPending({
            name,
            state,
          }),
        );
      },
    ),
  );
  return probe.pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.KMS.CryptoKeyVersionPending",
      times: 8,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
};

const desiredAlgorithm = (
  purpose: kms.CryptoKeyPurposeEnum,
  template: CryptoKeyVersionTemplate | undefined,
) =>
  template?.algorithm ??
  (purpose === "ENCRYPT_DECRYPT" ? DEFAULT_ALGORITHM : template?.algorithm);

const nextRotationFromPeriod = (period: string) =>
  Effect.sync(() => {
    const match = /^(\d+)s$/.exec(period);
    const seconds = match ? Number(match[1]) : 86_400;
    return new Date(Date.now() + seconds * 1000).toISOString();
  });

const destroyVersion = (name: string) =>
  kms
    .destroyProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
      name,
      body: {},
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.catchTag("BadRequest", () => Effect.void),
      Effect.catchTag("Conflict", () => Effect.void),
    );

const deleteVersion = (name: string) =>
  kms.deleteProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({ name }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
    Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
    Effect.flatMap(
      (
        operation,
      ): Effect.Effect<
        void,
        | CryptoKeyOperationFailed
        | OperationFailed
        | OperationTimedOut
        | kms.GetProjectsLocationsOperationsError,
        kms.GcpOpContext
      > =>
        operation === undefined
          ? Effect.void
          : waitOperation(operation).pipe(Effect.asVoid),
    ),
  );

const clearRotation = (name: string, current: kms.CryptoKey) => {
  if (!current.rotationPeriod && !current.nextRotationTime) {
    return Effect.void;
  }
  return kms
    .patchProjectsLocationsKeyRingsCryptoKeys({
      name,
      updateMask: "rotationPeriod,nextRotationTime",
      body: {},
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.asVoid,
    );
};

/**
 * Mark a key reclaimable: keep user labels, drop the stack/stage/id
 * ownership labels, and add {@link RELEASED_LABEL}.
 */
const releaseKey = (name: string, current: kms.CryptoKey) =>
  isReleased(current)
    ? Effect.void
    : kms
        .patchProjectsLocationsKeyRingsCryptoKeys({
          name,
          updateMask: "labels",
          body: {
            labels: { ...userLabels(current.labels), [RELEASED_LABEL]: "true" },
          },
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.asVoid,
        );

/**
 * Give a key usable material when it has none — a reclaimed released key,
 * or one whose versions were destroyed out of band. Symmetric keys also
 * need that version as their primary.
 */
const ensureUsableVersion = (
  name: string,
  current: kms.CryptoKey,
  purpose: kms.CryptoKeyPurposeEnum | (string & {}),
) =>
  Effect.gen(function* () {
    const symmetric = purpose === "ENCRYPT_DECRYPT";
    if (symmetric && USABLE_VERSION_STATES.has(current.primary?.state ?? "")) {
      return current;
    }
    const versions = yield* listVersions(name);
    let usable = versions.find((version) =>
      USABLE_VERSION_STATES.has(version.state ?? ""),
    );
    if (usable === undefined) {
      usable =
        yield* kms.createProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
          parent: name,
          body: {},
        });
    }
    if (!symmetric) return current;
    const versionId = lastSegment(usable.name ?? "");
    yield* kms.updatePrimaryVersionProjectsLocationsKeyRingsCryptoKeys({
      name,
      body: { cryptoKeyVersionId: versionId },
    });
    return yield* waitPrimaryReady(name);
  });

export const CryptoKeyProvider = () =>
  Provider.succeed(CryptoKey, {
    stables: [
      "name",
      "cryptoKeyId",
      "keyRing",
      "location",
      "project",
      "purpose",
      "destroyScheduledDuration",
      "importOnly",
      "cryptoKeyBackend",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.cryptoKeyId ?? output?.cryptoKeyId;
      const nextId = news.cryptoKeyId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousParent =
        output?.keyRing ??
        (olds?.keyRing
          ? resolveParent("", olds.keyRing, olds.location, env.region).parent
          : undefined);
      const nextParent = resolveParent(
        output?.project ?? "",
        news.keyRing,
        news.location ?? output?.location,
        env.region,
      ).parent;
      const parentChanged =
        previousParent !== undefined && previousParent !== nextParent;

      const previousPurpose =
        olds?.purpose ?? output?.purpose ?? DEFAULT_PURPOSE;
      const nextPurpose = news.purpose ?? DEFAULT_PURPOSE;
      const previousProtection = normalizeProtection(
        olds?.versionTemplate?.protectionLevel ??
          output?.versionTemplate?.protectionLevel,
      );
      const nextProtection = normalizeProtection(
        news.versionTemplate?.protectionLevel,
      );
      const previousImportOnly =
        olds?.importOnly ?? output?.importOnly ?? false;
      const nextImportOnly = news.importOnly === true;
      const previousDuration =
        olds?.destroyScheduledDuration ?? output?.destroyScheduledDuration;
      const nextDuration = news.destroyScheduledDuration;
      const previousBackend =
        olds?.cryptoKeyBackend ?? output?.cryptoKeyBackend;
      const nextBackend = news.cryptoKeyBackend;

      const replace =
        idChanged ||
        parentChanged ||
        previousPurpose !== nextPurpose ||
        previousProtection !== nextProtection ||
        previousImportOnly !== nextImportOnly ||
        (previousDuration !== undefined &&
          nextDuration !== undefined &&
          previousDuration !== nextDuration) ||
        (previousBackend ?? "") !== (nextBackend ?? "");

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        // A generated id folds every replacement trigger except the parent
        // into its hash, and a parent change moves rings, so the new
        // generation never collides with the old one. Only a fixed id
        // reused in the same ring must release the old key first.
        deleteFirst:
          news.cryptoKeyId !== undefined &&
          previousId !== undefined &&
          nextId === previousId &&
          !parentChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const cryptoKeyId = yield* toId(id, olds, output?.cryptoKeyId);
      const name =
        output?.name ??
        (olds?.keyRing || output?.keyRing
          ? resourceName(
              resolveParent(
                env.project,
                olds?.keyRing ?? output?.keyRing ?? "",
                olds?.location ?? output?.location,
                env.region,
              ).parent,
              cryptoKeyId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return isReleased(existing) ||
        (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: ReturnType<typeof toAttrs>[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* kms.listProjectsLocations({
            name: `projects/${env.project}`,
            pageSize: 100,
            pageToken,
          });
          const parents = (response.locations ?? [])
            .map((location) => location.name)
            .filter((name): name is string => !!name);
          const batches = yield* Effect.forEach(
            parents,
            (parent) => listCryptoKeysAt(parent),
            { concurrency: 4 },
          );
          for (const keys of batches) {
            for (const key of keys) {
              found.push(toAttrs(key, env.project, env.region));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const cryptoKeyId = yield* toId(id, news, output?.cryptoKeyId);
      const parent = resolveParent(
        env.project,
        news.keyRing,
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(parent.parent, cryptoKeyId);
      const purpose = news.purpose ?? DEFAULT_PURPOSE;
      const algorithm = desiredAlgorithm(purpose, news.versionTemplate);
      const protectionLevel = news.versionTemplate?.protectionLevel;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const rotationPeriod = news.rotationPeriod;
      const nextRotationTime = rotationPeriod
        ? (news.nextRotationTime ??
          (yield* nextRotationFromPeriod(rotationPeriod)))
        : news.nextRotationTime;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* kms
          .createProjectsLocationsKeyRingsCryptoKeys({
            parent: parent.parent,
            cryptoKeyId,
            skipInitialVersionCreation: news.skipInitialVersionCreation,
            body: {
              purpose,
              labels: desiredLabels,
              versionTemplate: {
                algorithm,
                protectionLevel,
              },
              rotationPeriod,
              nextRotationTime,
              destroyScheduledDuration: news.destroyScheduledDuration,
              importOnly: news.importOnly,
              cryptoKeyBackend: news.cryptoKeyBackend,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (
          current !== undefined &&
          news.skipInitialVersionCreation !== true &&
          current.primary?.state === "PENDING_GENERATION"
        ) {
          current = yield* waitPrimaryReady(name);
        }
      }

      if (current === undefined) {
        return yield* new CryptoKeyNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const observedAlgorithm = current.versionTemplate?.algorithm;
      const algorithmChanged =
        algorithm !== undefined && observedAlgorithm !== algorithm;
      const rotationChanged =
        (current.rotationPeriod ?? "") !== (rotationPeriod ?? "") ||
        (news.nextRotationTime !== undefined &&
          (current.nextRotationTime ?? "") !== news.nextRotationTime);

      if (labelsChanged || algorithmChanged || rotationChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          algorithmChanged ? "versionTemplate.algorithm" : undefined,
          rotationChanged ? "rotationPeriod" : undefined,
          rotationChanged ? "nextRotationTime" : undefined,
        ]
          .filter((field): field is string => field !== undefined)
          .join(",");
        current = yield* kms.patchProjectsLocationsKeyRingsCryptoKeys({
          name,
          updateMask,
          body: {
            labels: desiredLabels,
            versionTemplate: algorithmChanged
              ? {
                  algorithm,
                  protectionLevel:
                    protectionLevel ?? current.versionTemplate?.protectionLevel,
                }
              : undefined,
            rotationPeriod,
            nextRotationTime,
          },
        });
      }

      if (
        news.skipInitialVersionCreation !== true &&
        news.importOnly !== true
      ) {
        current = yield* ensureUsableVersion(name, current, purpose);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      const current = yield* getByName(name);
      if (current === undefined) return;

      yield* clearRotation(name, current);
      yield* releaseKey(name, current);

      const versions = yield* listVersions(name);
      yield* Effect.forEach(
        versions,
        (version) => {
          const versionName = version.name;
          if (versionName === undefined) return Effect.void;
          const state = version.state ?? "";
          if (DESTROYABLE_VERSION_STATES.has(state)) {
            return destroyVersion(versionName);
          }
          if (DELETABLE_VERSION_STATES.has(state)) {
            return deleteVersion(versionName);
          }
          return Effect.void;
        },
        { concurrency: 4 },
      );

      // The key itself is never deleted: KMS retires a deleted key's name
      // forever, which would make this id (fixed or the deterministic
      // default) undeployable. The released key is reclaimed on redeploy.
    }),
  });
