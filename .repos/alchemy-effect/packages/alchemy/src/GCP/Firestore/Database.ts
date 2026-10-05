import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_TYPE = "FIRESTORE_NATIVE";
const DEFAULT_EDITION = "STANDARD";
const DEFAULT_DELETE_PROTECTION = "DELETE_PROTECTION_DISABLED";
const DEFAULT_APP_ENGINE = "DISABLED";
const MAX_DATABASE_ID_LENGTH = 63;

export type DatabaseType =
  | firestore.GoogleFirestoreAdminV1DatabaseTypeEnum
  | (string & {});
export type DatabaseEdition =
  | firestore.GoogleFirestoreAdminV1DatabaseDatabaseEditionEnum
  | (string & {});
export type DatabaseConcurrencyMode =
  | firestore.GoogleFirestoreAdminV1DatabaseConcurrencyModeEnum
  | (string & {});
export type DatabasePointInTimeRecoveryEnablement =
  | firestore.GoogleFirestoreAdminV1DatabasePointInTimeRecoveryEnablementEnum
  | (string & {});
export type DatabaseAppEngineIntegrationMode =
  | firestore.GoogleFirestoreAdminV1DatabaseAppEngineIntegrationModeEnum
  | (string & {});
export type DatabaseDeleteProtectionState =
  | firestore.GoogleFirestoreAdminV1DatabaseDeleteProtectionStateEnum
  | (string & {});
export type DatabaseRealtimeUpdatesMode =
  | firestore.GoogleFirestoreAdminV1DatabaseRealtimeUpdatesModeEnum
  | (string & {});
export type DatabaseDataAccessMode =
  | firestore.GoogleFirestoreAdminV1DatabaseFirestoreDataAccessModeEnum
  | (string & {});

export type DatabaseCmekConfig = {
  /**
   * Cloud KMS CryptoKey used to encrypt the database
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Must be in the same location as the database. Immutable — changing
   * it replaces the database.
   */
  kmsKeyName?: string;
};

export type DatabaseProps = {
  /**
   * Database id (the `{database}` segment of
   * `projects/{project}/databases/{database}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must be 4-63
   * characters, match `[a-z][a-z0-9-]*[a-z0-9]`, and must not look like a
   * UUID. `"(default)"` is valid for the Standard edition default
   * database. Immutable — changing it replaces the database.
   */
  databaseId?: string;
  /**
   * Location of the database (`us-central1`, `nam5`, `eur3`, …).
   * Immutable — changing it replaces the database. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Database type. Mode changes are only allowed when the database is
   * empty.
   * @default "FIRESTORE_NATIVE"
   */
  type?: DatabaseType;
  /**
   * Database edition. Immutable — changing it replaces the database.
   * @default "STANDARD"
   */
  databaseEdition?: DatabaseEdition;
  /**
   * Default transaction concurrency mode. Defaults to `PESSIMISTIC` for
   * Standard edition and `OPTIMISTIC` for Enterprise.
   */
  concurrencyMode?: DatabaseConcurrencyMode;
  /**
   * Point-in-time recovery. When enabled, version retention is 7 days
   * instead of 1 hour.
   * @default "POINT_IN_TIME_RECOVERY_DISABLED"
   */
  pointInTimeRecoveryEnablement?: DatabasePointInTimeRecoveryEnablement;
  /**
   * App Engine integration mode. `DISABLED` is the API default for
   * databases created with the Firestore API.
   * @default "DISABLED"
   */
  appEngineIntegrationMode?: DatabaseAppEngineIntegrationMode;
  /**
   * Delete protection. Alchemy defaults to disabled so `destroy` can
   * delete the database.
   * @default "DELETE_PROTECTION_DISABLED"
   */
  deleteProtectionState?: DatabaseDeleteProtectionState;
  /**
   * Default Realtime Updates mode. Immutable — changing it replaces the
   * database.
   */
  realtimeUpdatesMode?: DatabaseRealtimeUpdatesMode;
  /**
   * Firestore API data access mode. Defaults to enabled on Standard
   * edition and disabled on Enterprise.
   */
  firestoreDataAccessMode?: DatabaseDataAccessMode;
  /**
   * MongoDB-compatible API data access mode. Always disabled on Standard
   * edition.
   */
  mongodbCompatibleDataAccessMode?: DatabaseDataAccessMode;
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * database.
   */
  cmekConfig?: DatabaseCmekConfig;
};

export type Database = Resource<
  "GCP.Firestore.Database",
  DatabaseProps,
  {
    /** Full resource name `projects/{project}/databases/{database}`. */
    name: string;
    /** Database id (last path segment). */
    databaseId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `nam5`, …). */
    location: string;
    /** Database type (`FIRESTORE_NATIVE`, `DATASTORE_MODE`). */
    type: string;
    /** Database edition (`STANDARD`, `ENTERPRISE`). */
    databaseEdition: string | undefined;
    /** Default concurrency mode. */
    concurrencyMode: string | undefined;
    /** Point-in-time recovery enablement. */
    pointInTimeRecoveryEnablement: string | undefined;
    /** App Engine integration mode. */
    appEngineIntegrationMode: string | undefined;
    /** Delete protection state. */
    deleteProtectionState: string | undefined;
    /** Realtime Updates mode. */
    realtimeUpdatesMode: string | undefined;
    /** Firestore API data access mode. */
    firestoreDataAccessMode: string | undefined;
    /** MongoDB-compatible API data access mode. */
    mongodbCompatibleDataAccessMode: string | undefined;
    /** CMEK key, if any. */
    kmsKeyName: string | undefined;
    /** System-generated UUID4. */
    uid: string | undefined;
    /** Datastore key prefix, if any. */
    keyPrefix: string | undefined;
    /** Whether this database is eligible for the free tier. */
    freeTier: boolean | undefined;
    /** Version retention period (e.g. `"3600s"`). */
    versionRetentionPeriod: string | undefined;
    /** Earliest PITR timestamp, if available. */
    earliestVersionTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Firestore database.
 *
 * Firestore databases have no labels field and Alchemy writes no data
 * into them: `read` reports a database it finds without prior state as
 * unowned (adopt it with `--adopt`). Changing `databaseId`, `location`, `databaseEdition`, CMEK, or
 * Realtime Updates mode replaces the database.
 *
 * Create, update, and delete are long-running operations — provisioning
 * a named database typically takes tens of seconds.
 *
 * ### Creating a Database
 * **Example:** Generated name
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {});
 * ```
 *
 * **Example:** Explicit id, location, and concurrency
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {
 *   databaseId: "app-data",
 *   location: "us-central1",
 *   type: "FIRESTORE_NATIVE",
 *   concurrencyMode: "OPTIMISTIC",
 * });
 * ```
 *
 * ### Reading and Writing Documents
 * **Example:** Upsert and read a document
 * ```typescript
 * const patchDocument = yield* GCP.Firestore.PatchDocument(database);
 * yield* patchDocument({
 *   documentPath: "users/alice",
 *   body: { fields: { name: { stringValue: "Alice" } } },
 * });
 * const getDocument = yield* GCP.Firestore.GetDocument(database);
 * const doc = yield* getDocument({ documentPath: "users/alice" });
 * ```
 *
 * @resource
 * @category Firestore
 */
export const Database = Resource<Database>("GCP.Firestore.Database");

export class DatabaseNotResolved extends Data.TaggedError(
  "GCP.Firestore.DatabaseNotResolved",
)<{
  name: string;
}> {}

export class DatabaseStillExists extends Data.TaggedError(
  "GCP.Firestore.DatabaseStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

const normalizeType = (value: string | undefined) =>
  normalizeEnum(value, DEFAULT_TYPE);

const normalizeEdition = (value: string | undefined) =>
  normalizeEnum(value, DEFAULT_EDITION);

const resourceName = (project: string, databaseId: string) =>
  `projects/${project}/databases/${databaseId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const databasesAt = parts.lastIndexOf("databases");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    databaseId:
      databasesAt >= 0 && parts[databasesAt + 1]
        ? parts[databasesAt + 1]!
        : lastSegment(name),
  };
};

const toDatabaseId = (
  id: string,
  databaseId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (databaseId !== undefined) return databaseId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_DATABASE_ID_LENGTH,
      lowercase: true,
    });
    let named = /^[a-z]/.test(generated) ? generated : `f${generated}`;
    named = named.replace(/-+$/g, "").slice(0, MAX_DATABASE_ID_LENGTH);
    named = named.replace(/-+$/g, "");
    if (named.length < 4) {
      named = `${named}dbxx`.slice(0, MAX_DATABASE_ID_LENGTH);
    }
    return named;
  });

const toAttrs = (
  database: firestore.GoogleFirestoreAdminV1Database,
  project: string,
): Database["Attributes"] => {
  const name = database.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    databaseId: parsed.databaseId,
    project: parsed.project || project,
    location: normalizeLocation(database.locationId, ""),
    type: normalizeType(database.type),
    databaseEdition: database.databaseEdition,
    concurrencyMode: database.concurrencyMode,
    pointInTimeRecoveryEnablement: database.pointInTimeRecoveryEnablement,
    appEngineIntegrationMode: database.appEngineIntegrationMode,
    deleteProtectionState: database.deleteProtectionState,
    realtimeUpdatesMode: database.realtimeUpdatesMode,
    firestoreDataAccessMode: database.firestoreDataAccessMode,
    mongodbCompatibleDataAccessMode: database.mongodbCompatibleDataAccessMode,
    kmsKeyName: database.cmekConfig?.kmsKeyName,
    uid: database.uid,
    keyPrefix: database.keyPrefix,
    freeTier: database.freeTier,
    versionRetentionPeriod: database.versionRetentionPeriod,
    earliestVersionTime: database.earliestVersionTime,
    createTime: database.createTime,
    updateTime: database.updateTime,
    etag: database.etag,
  };
};

const getByName = (name: string) =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined ? undefined : database,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/**
 * Wait for a Firestore admin operation; named databases provision in tens
 * of seconds to a few minutes. With `alreadyExistsOk`, ALREADY_EXISTS
 * (code 6) counts as success (create race).
 */
const waitForOperation = (
  operation: firestore.GoogleLongrunningOperation,
  options?: { alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) => firestore.getProjectsDatabasesOperations({ name }),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        options?.alreadyExistsOk === true &&
        error._tag === "GCP.OperationFailed" &&
        error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (database): database is firestore.GoogleFirestoreAdminV1Database =>
        database !== undefined,
      () => new DatabaseNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.DatabaseNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (database) => database === undefined,
      () => new DatabaseStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.DatabaseStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
    Effect.asVoid,
  );

const retryConcurrentChanges = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const enumChanged = (
  desired: string | undefined,
  observed: string | undefined,
) => {
  if (desired === undefined) return false;
  return normalizeEnum(observed, desired) !== normalizeEnum(desired, desired);
};

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: [
      "name",
      "databaseId",
      "project",
      "location",
      "uid",
      "createTime",
      "keyPrefix",
      "databaseEdition",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;

      const previousId = olds?.databaseId ?? output?.databaseId;
      const nextId = news.databaseId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousEdition = normalizeEdition(
        olds?.databaseEdition ?? output?.databaseEdition,
      );
      const nextEdition = normalizeEdition(
        news.databaseEdition ?? output?.databaseEdition,
      );
      const previousKms =
        olds?.cmekConfig?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKms = news.cmekConfig?.kmsKeyName ?? previousKms;
      const previousRealtime = (
        olds?.realtimeUpdatesMode ??
        output?.realtimeUpdatesMode ??
        ""
      ).toUpperCase();
      const nextRealtime = (
        news.realtimeUpdatesMode ??
        output?.realtimeUpdatesMode ??
        previousRealtime
      ).toUpperCase();

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousEdition !== nextEdition ||
        previousKms !== nextKms ||
        (news.realtimeUpdatesMode !== undefined &&
          previousRealtime !== nextRealtime);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousId !== undefined &&
          nextId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const databaseId = yield* toDatabaseId(
        id,
        olds?.databaseId,
        output?.databaseId,
      );
      const name = output?.name ?? resourceName(env.project, databaseId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const databaseId = yield* toDatabaseId(
        id,
        news.databaseId,
        output?.databaseId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const type = normalizeType(news.type);
      const name = resourceName(env.project, databaseId);
      const desiredProtection =
        news.deleteProtectionState ?? DEFAULT_DELETE_PROTECTION;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* firestore
          .createProjectsDatabases({
            parent: `projects/${env.project}`,
            databaseId,
            body: {
              locationId: location,
              type,
              databaseEdition: news.databaseEdition
                ? normalizeEdition(news.databaseEdition)
                : undefined,
              concurrencyMode: news.concurrencyMode,
              pointInTimeRecoveryEnablement: news.pointInTimeRecoveryEnablement,
              appEngineIntegrationMode:
                news.appEngineIntegrationMode ?? DEFAULT_APP_ENGINE,
              deleteProtectionState: desiredProtection,
              realtimeUpdatesMode: news.realtimeUpdatesMode,
              firestoreDataAccessMode: news.firestoreDataAccessMode,
              mongodbCompatibleDataAccessMode:
                news.mongodbCompatibleDataAccessMode,
              cmekConfig: news.cmekConfig?.kmsKeyName
                ? { kmsKeyName: news.cmekConfig.kmsKeyName }
                : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new DatabaseNotResolved({ name });
      }

      const mask: string[] = [];
      const patchBody: firestore.GoogleFirestoreAdminV1Database = {};

      if (enumChanged(type, current.type)) {
        patchBody.type = type;
        mask.push("type");
      }
      if (enumChanged(news.concurrencyMode, current.concurrencyMode)) {
        patchBody.concurrencyMode = news.concurrencyMode;
        mask.push("concurrencyMode");
      }
      if (
        enumChanged(
          news.pointInTimeRecoveryEnablement,
          current.pointInTimeRecoveryEnablement,
        )
      ) {
        patchBody.pointInTimeRecoveryEnablement =
          news.pointInTimeRecoveryEnablement;
        mask.push("pointInTimeRecoveryEnablement");
      }
      if (
        enumChanged(
          news.appEngineIntegrationMode,
          current.appEngineIntegrationMode,
        )
      ) {
        patchBody.appEngineIntegrationMode = news.appEngineIntegrationMode;
        mask.push("appEngineIntegrationMode");
      }
      if (enumChanged(desiredProtection, current.deleteProtectionState)) {
        patchBody.deleteProtectionState = desiredProtection;
        mask.push("deleteProtectionState");
      }
      if (
        enumChanged(
          news.firestoreDataAccessMode,
          current.firestoreDataAccessMode,
        )
      ) {
        patchBody.firestoreDataAccessMode = news.firestoreDataAccessMode;
        mask.push("firestoreDataAccessMode");
      }
      if (
        enumChanged(
          news.mongodbCompatibleDataAccessMode,
          current.mongodbCompatibleDataAccessMode,
        )
      ) {
        patchBody.mongodbCompatibleDataAccessMode =
          news.mongodbCompatibleDataAccessMode;
        mask.push("mongodbCompatibleDataAccessMode");
      }

      if (mask.length > 0) {
        const patched = yield* retryConcurrentChanges(
          firestore.patchProjectsDatabases({
            name,
            updateMask: mask.join(","),
            body: patchBody,
          }),
        );
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getByName(output.name);
      if (current === undefined) return;

      if (
        normalizeEnum(
          current.deleteProtectionState,
          DEFAULT_DELETE_PROTECTION,
        ) === "DELETE_PROTECTION_ENABLED"
      ) {
        const patched = yield* retryConcurrentChanges(
          firestore.patchProjectsDatabases({
            name: output.name,
            updateMask: "deleteProtectionState",
            body: {
              deleteProtectionState: DEFAULT_DELETE_PROTECTION,
            },
          }),
        );
        yield* waitForOperation(patched);
      }

      yield* retryConcurrentChanges(
        firestore.deleteProjectsDatabases({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      // Soft-delete: GET reports `deleteTime` long before the LRO is done.
      yield* waitUntilGone(output.name);
    }),
  });
