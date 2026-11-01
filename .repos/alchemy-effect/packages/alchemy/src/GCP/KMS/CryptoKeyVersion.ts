import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type OperationFailed,
  type OperationTimedOut,
  waitForOperation as waitForGcpOperation,
} from "../Operation.ts";

const DEFAULT_STATE: kms.CryptoKeyVersionStateEnum = "ENABLED";
const DELETABLE_STATES = new Set([
  "DESTROYED",
  "IMPORT_FAILED",
  "GENERATION_FAILED",
]);
const DESTROYABLE_STATES = new Set(["ENABLED", "DISABLED"]);
const PATCHABLE_STATES = new Set(["ENABLED", "DISABLED"]);

export type CryptoKeyVersionExternalProtectionLevelOptions = {
  /**
   * URI of the external key this version represents. EXTERNAL
   * protection level only.
   */
  externalKeyUri?: string;
  /**
   * Path to the external key material on the EKM when using an
   * EkmConnection (e.g. `"v0/my/key"`). EXTERNAL_VPC protection level
   * only.
   */
  ekmConnectionKeyPath?: string;
};

export type CryptoKeyVersionProps = {
  /**
   * Parent CryptoKey. Full name
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`
   * or the crypto key id (combined with `keyRing` / `location`).
   * Immutable — changing it replaces the version.
   */
  cryptoKey: string;
  /**
   * Parent KeyRing. Full name
   * `projects/{project}/locations/{location}/keyRings/{keyRing}` or the
   * key ring id. Used when `cryptoKey` is a bare id. Immutable —
   * changing it replaces the version.
   */
  keyRing?: string;
  /**
   * Cloud KMS location (`us-central1`, `global`, `us`, …). Used when
   * `cryptoKey` is a bare id. Immutable — changing it replaces the
   * version. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * CryptoKeyVersion id (the last path segment, typically a decimal
   * sequence assigned by Cloud KMS). Create always assigns the next
   * sequential id; this field targets an existing version on adopt or
   * update. Changing it replaces the version.
   */
  cryptoKeyVersionId?: string;
  /**
   * Desired version state. `ENABLED` and `DISABLED` patch in place.
   * Other transitions use Destroy / Restore. Cloud KMS sets
   * `PENDING_GENERATION` on create until the key material is ready.
   * @default "ENABLED"
   */
  state?: kms.CryptoKeyVersionStateEnum;
  /**
   * External / EXTERNAL_VPC key material pointer. Ignored for SOFTWARE
   * and HSM keys.
   */
  externalProtectionLevelOptions?: CryptoKeyVersionExternalProtectionLevelOptions;
};

export type CryptoKeyVersionAttrs = {
  /** Full resource name `projects/.../cryptoKeyVersions/{version}`. */
  name: string;
  /** CryptoKeyVersion id (last path segment). */
  cryptoKeyVersionId: string;
  /** Parent CryptoKey resource name. */
  cryptoKey: string;
  /** Parent KeyRing resource name. */
  keyRing: string;
  /** Location id (`us-central1`, `global`, …). */
  location: string;
  /** Project id. */
  project: string;
  /** Current version state. */
  state: string;
  /** Algorithm from the parent CryptoKey version template. */
  algorithm: string | undefined;
  /** Protection level of this version. */
  protectionLevel: string | undefined;
  /** External key pointer, if any. */
  externalProtectionLevelOptions:
    | CryptoKeyVersionExternalProtectionLevelOptions
    | undefined;
  /** Import job that produced this version, if imported. */
  importJob: string | undefined;
  /** Whether the version can be reimported. */
  reimportEligible: boolean;
  /** RFC3339 creation timestamp. */
  createTime: string | undefined;
  /** RFC3339 generation timestamp. */
  generateTime: string | undefined;
  /** RFC3339 scheduled-destruction timestamp. */
  destroyTime: string | undefined;
  /** RFC3339 time key material was destroyed. */
  destroyEventTime: string | undefined;
  /** Generation failure reason, if `state` is `GENERATION_FAILED`. */
  generationFailureReason: string | undefined;
};

export type CryptoKeyVersion = Resource<
  "GCP.KMS.CryptoKeyVersion",
  CryptoKeyVersionProps,
  CryptoKeyVersionAttrs,
  never,
  Providers
>;

/**
 * A Cloud KMS CryptoKeyVersion — one generation of key material under a
 * CryptoKey.
 *
 * Parent CryptoKey, KeyRing, location, and version id are identity
 * (changing them replaces the version). `state` toggles between
 * `ENABLED` and `DISABLED` in place. Cloud KMS assigns sequential
 * version ids on create; versions have no labels, so `list` returns
 * versions whose parent CryptoKey carries Alchemy ownership labels.
 *
 * Destroy schedules destruction (`DESTROY_SCHEDULED`, minimum 24h).
 * Permanent `delete` is only possible for `DESTROYED`, `IMPORT_FAILED`,
 * or `GENERATION_FAILED` versions that were never successfully imported.
 *
 * ### Creating a CryptoKeyVersion
 * **Example:** Next version on an existing CryptoKey
 * ```typescript
 * const ring = yield* GCP.KMS.KeyRing("Keys", {});
 * const key = yield* GCP.KMS.CryptoKey("Data", {
 *   keyRing: ring.name,
 *   skipInitialVersionCreation: true,
 * });
 * const version = yield* GCP.KMS.CryptoKeyVersion("V1", {
 *   cryptoKey: key.name,
 * });
 * ```
 *
 * **Example:** Disabled version
 * ```typescript
 * const version = yield* GCP.KMS.CryptoKeyVersion("V1", {
 *   cryptoKey: key.name,
 *   state: "DISABLED",
 * });
 * ```
 *
 * @resource
 * @category KMS
 */
export const CryptoKeyVersion = Resource<CryptoKeyVersion>(
  "GCP.KMS.CryptoKeyVersion",
);

export class CryptoKeyVersionNotResolved extends Data.TaggedError(
  "GCP.KMS.CryptoKeyVersionNotResolved",
)<{
  name: string;
}> {}

export class CryptoKeyVersionOperationFailed extends Data.TaggedError(
  "GCP.KMS.CryptoKeyVersionOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class CryptoKeyVersionNotReady extends Data.TaggedError(
  "GCP.KMS.CryptoKeyVersionNotReady",
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

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const versionsAt = parts.lastIndexOf("cryptoKeyVersions");
  const cryptoKeysAt = parts.lastIndexOf("cryptoKeys");
  const keyRingsAt = parts.lastIndexOf("keyRings");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const cryptoKey =
    cryptoKeysAt >= 0 ? parts.slice(0, cryptoKeysAt + 2).join("/") : "";
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
    cryptoKey,
    cryptoKeyVersionId:
      versionsAt >= 0 && parts[versionsAt + 1]
        ? parts[versionsAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  cryptoKey: string,
  keyRing: string | undefined,
  location: string | undefined,
  region: string,
) => {
  if (cryptoKey.includes("/cryptoKeyVersions/")) {
    const parsed = parseName(cryptoKey, region);
    return {
      parent: parsed.cryptoKey,
      location: parsed.location,
      project: parsed.project || project,
    };
  }
  if (cryptoKey.includes("/cryptoKeys/")) {
    const parsed = parseName(`${cryptoKey}/cryptoKeyVersions/_`, region);
    return {
      parent: parsed.cryptoKey,
      location: parsed.location,
      project: parsed.project || project,
    };
  }
  const loc = normalizeLocation(location, region);
  const ring =
    keyRing !== undefined && keyRing.includes("/")
      ? keyRing
      : `projects/${project}/locations/${loc}/keyRings/${keyRing ?? "default"}`;
  return {
    parent: `${ring}/cryptoKeys/${cryptoKey}`,
    location: loc,
    project,
  };
};

const resourceName = (parent: string, cryptoKeyVersionId: string) =>
  `${parent}/cryptoKeyVersions/${cryptoKeyVersionId}`;

const desiredState = (
  value: string | undefined,
): kms.CryptoKeyVersionStateEnum =>
  !value || value === "CRYPTO_KEY_VERSION_STATE_UNSPECIFIED"
    ? DEFAULT_STATE
    : (value as kms.CryptoKeyVersionStateEnum);

const toAttrs = (
  version: kms.CryptoKeyVersion,
  project: string,
  region: string,
): CryptoKeyVersionAttrs => {
  const name = version.name ?? "";
  const parsed = parseName(name, region);
  const options = version.externalProtectionLevelOptions;
  return {
    name,
    cryptoKeyVersionId: parsed.cryptoKeyVersionId,
    cryptoKey: parsed.cryptoKey,
    keyRing: parsed.keyRing,
    location: parsed.location,
    project: parsed.project || project,
    state: version.state ?? DEFAULT_STATE,
    algorithm: version.algorithm,
    protectionLevel: version.protectionLevel,
    externalProtectionLevelOptions:
      options === undefined
        ? undefined
        : {
            externalKeyUri: options.externalKeyUri,
            ekmConnectionKeyPath: options.ekmConnectionKeyPath,
          },
    importJob: version.importJob,
    reimportEligible: version.reimportEligible === true,
    createTime: version.createTime,
    generateTime: version.generateTime,
    destroyTime: version.destroyTime,
    destroyEventTime: version.destroyEventTime,
    generationFailureReason: version.generationFailureReason,
  };
};

const getByName = (name: string) =>
  kms
    .getProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({ name })
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

const listAlchemyKeysInRing = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRingsCryptoKeys({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: (response.cryptoKeys ?? []).filter((key) =>
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

const listVersionsInKey = (parent: string) =>
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

const listVersionsAt = (locationParent: string) =>
  Effect.gen(function* () {
    const rings = yield* listKeyRingsAt(locationParent);
    const keyPages = yield* Effect.forEach(
      rings,
      (ring) =>
        ring.name
          ? listAlchemyKeysInRing(ring.name)
          : Effect.succeed([] as kms.CryptoKey[]),
      { concurrency: 4 },
    );
    const keys = keyPages.flat();
    const versionPages = yield* Effect.forEach(
      keys,
      (key) =>
        key.name
          ? listVersionsInKey(key.name)
          : Effect.succeed([] as kms.CryptoKeyVersion[]),
      { concurrency: 4 },
    );
    return versionPages.flat();
  });

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

const waitReady = (
  name: string,
): Effect.Effect<
  kms.CryptoKeyVersion,
  | CryptoKeyVersionNotResolved
  | CryptoKeyVersionOperationFailed
  | CryptoKeyVersionNotReady
  | kms.GetProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersionsError,
  kms.GcpOpContext
> => {
  const probe: Effect.Effect<
    kms.CryptoKeyVersion,
    | CryptoKeyVersionNotResolved
    | CryptoKeyVersionOperationFailed
    | CryptoKeyVersionNotReady
    | kms.GetProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersionsError,
    kms.GcpOpContext
  > = getByName(name).pipe(
    Effect.flatMap(
      (
        version,
      ): Effect.Effect<
        kms.CryptoKeyVersion,
        | CryptoKeyVersionNotResolved
        | CryptoKeyVersionOperationFailed
        | CryptoKeyVersionNotReady
      > => {
        if (version === undefined) {
          return Effect.fail(new CryptoKeyVersionNotResolved({ name }));
        }
        const state = version.state;
        if (
          state === undefined ||
          state === "ENABLED" ||
          state === "DISABLED" ||
          state === "DESTROY_SCHEDULED" ||
          state === "DESTROYED"
        ) {
          return Effect.succeed(version);
        }
        if (state === "GENERATION_FAILED") {
          return Effect.fail(
            new CryptoKeyVersionOperationFailed({
              operation: version.name ?? name,
              message: version.generationFailureReason ?? state,
            }),
          );
        }
        if (state === "IMPORT_FAILED") {
          return Effect.fail(
            new CryptoKeyVersionOperationFailed({
              operation: version.name ?? name,
              message: version.importFailureReason ?? state,
            }),
          );
        }
        return Effect.fail(
          new CryptoKeyVersionNotReady({
            name,
            state: state ?? "PENDING_GENERATION",
          }),
        );
      },
    ),
  );
  return probe.pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.KMS.CryptoKeyVersionNotReady",
      times: 8,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
};

const optionsEqual = (
  observed: kms.ExternalProtectionLevelOptions | undefined,
  desired: CryptoKeyVersionExternalProtectionLevelOptions | undefined,
) =>
  (observed?.externalKeyUri ?? "") === (desired?.externalKeyUri ?? "") &&
  (observed?.ekmConnectionKeyPath ?? "") ===
    (desired?.ekmConnectionKeyPath ?? "");

const destroyVersion = (name: string) =>
  kms
    .destroyProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
      name,
      body: {},
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
      Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
    );

const restoreVersion = (name: string) =>
  kms
    .restoreProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
      name,
      body: {},
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
      Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
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
        | CryptoKeyVersionOperationFailed
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

const resolveName = (args: {
  outputName: string | undefined;
  outputVersionId: string | undefined;
  propsVersionId: string | undefined;
  parent: string;
}) => {
  if (args.outputName !== undefined) return args.outputName;
  const versionId = args.propsVersionId ?? args.outputVersionId;
  return versionId !== undefined
    ? resourceName(args.parent, versionId)
    : undefined;
};

export const CryptoKeyVersionProvider = () =>
  Provider.succeed(CryptoKeyVersion, {
    stables: [
      "name",
      "cryptoKeyVersionId",
      "cryptoKey",
      "keyRing",
      "location",
      "project",
      "algorithm",
      "protectionLevel",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.cryptoKeyVersionId ?? output?.cryptoKeyVersionId;
      const nextId = news.cryptoKeyVersionId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousParent =
        output?.cryptoKey ??
        (olds?.cryptoKey
          ? resolveParent(
              "",
              olds.cryptoKey,
              olds.keyRing,
              olds.location,
              env.region,
            ).parent
          : undefined);
      const nextParent = resolveParent(
        output?.project ?? "",
        news.cryptoKey,
        news.keyRing ?? output?.keyRing,
        news.location ?? output?.location,
        env.region,
      ).parent;
      const parentChanged =
        previousParent !== undefined && previousParent !== nextParent;

      if (!idChanged && !parentChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent =
        olds?.cryptoKey || output?.cryptoKey
          ? resolveParent(
              env.project,
              olds?.cryptoKey ?? output?.cryptoKey ?? "",
              olds?.keyRing ?? output?.keyRing,
              olds?.location ?? output?.location,
              env.region,
            ).parent
          : undefined;
      const name = resolveName({
        outputName: output?.name,
        outputVersionId: output?.cryptoKeyVersionId,
        propsVersionId: olds?.cryptoKeyVersionId,
        parent: parent ?? "",
      });
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      if (DELETABLE_STATES.has(existing.state ?? "")) return undefined;
      // Versions have no labels. Existence at the stored name is
      // ownership; adopting a version of an alchemy-labeled key is
      // harmless.
      return toAttrs(existing, env.project, env.region);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: CryptoKeyVersionAttrs[] = [];
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
            (parent) => listVersionsAt(parent),
            { concurrency: 4 },
          );
          for (const versions of batches) {
            for (const version of versions) {
              if (version.state === "DESTROY_SCHEDULED") continue;
              found.push(toAttrs(version, env.project, env.region));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = resolveParent(
        env.project,
        news.cryptoKey,
        news.keyRing ?? output?.keyRing,
        news.location ?? output?.location,
        env.region,
      );
      const name = resolveName({
        outputName: output?.name,
        outputVersionId: output?.cryptoKeyVersionId,
        propsVersionId: news.cryptoKeyVersionId,
        parent: parent.parent,
      });
      const targetState = desiredState(news.state);

      let current = name === undefined ? undefined : yield* getByName(name);

      if (current !== undefined && DELETABLE_STATES.has(current.state ?? "")) {
        if (current.name !== undefined) {
          yield* deleteVersion(current.name);
        }
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* kms
          .createProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
            parent: parent.parent,
            body: {
              state: targetState === "DISABLED" ? "DISABLED" : undefined,
              externalProtectionLevelOptions:
                news.externalProtectionLevelOptions,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              name !== undefined ? getByName(name) : Effect.succeed(undefined),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || current.name === undefined) {
        return yield* new CryptoKeyVersionNotResolved({
          name: name ?? resourceName(parent.parent, "unknown"),
        });
      }

      const currentName = current.name;
      if (
        current.state === "PENDING_GENERATION" ||
        current.state === "PENDING_IMPORT"
      ) {
        current = yield* waitReady(currentName);
      }

      if (
        current.state === "DESTROY_SCHEDULED" &&
        PATCHABLE_STATES.has(targetState)
      ) {
        const restored = yield* restoreVersion(currentName);
        current = restored ?? (yield* waitReady(currentName));
      }

      const observedState = current.state ?? DEFAULT_STATE;
      const stateChanged =
        PATCHABLE_STATES.has(targetState) &&
        PATCHABLE_STATES.has(observedState) &&
        observedState !== targetState;
      const optionsChanged =
        news.externalProtectionLevelOptions !== undefined &&
        !optionsEqual(
          current.externalProtectionLevelOptions,
          news.externalProtectionLevelOptions,
        );

      if (stateChanged || optionsChanged) {
        const updateMask = [
          stateChanged ? "state" : undefined,
          optionsChanged ? "externalProtectionLevelOptions" : undefined,
        ]
          .filter((field): field is string => field !== undefined)
          .join(",");
        current =
          yield* kms.patchProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
            name: currentName,
            updateMask,
            body: {
              state: stateChanged ? targetState : undefined,
              externalProtectionLevelOptions: optionsChanged
                ? news.externalProtectionLevelOptions
                : undefined,
            },
          });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      const current = yield* getByName(name);
      if (current === undefined) return;

      const state = current.state ?? "";
      if (DESTROYABLE_STATES.has(state)) {
        yield* destroyVersion(name);
        return;
      }
      if (DELETABLE_STATES.has(state)) {
        yield* deleteVersion(name);
      }
    }),
  });
