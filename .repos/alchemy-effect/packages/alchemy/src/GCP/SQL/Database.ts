import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { recoverIfInstanceMissing, waitForSqlOperation } from "./operations.ts";

const MAX_NAME_LENGTH = 63;

const SYSTEM_DATABASES = new Set([
  "mysql",
  "information_schema",
  "performance_schema",
  "sys",
  "postgres",
  "template0",
  "template1",
  "master",
  "model",
  "msdb",
  "tempdb",
]);

export type DatabaseDeletionPolicy = "DELETE" | "ABANDON";

export type SqlServerDatabaseDetails = {
  /**
   * SQL Server compatibility level (e.g. `150`).
   */
  compatibilityLevel?: number;
  /**
   * SQL Server recovery model (`FULL`, `SIMPLE`, `BULK_LOGGED`).
   */
  recoveryModel?: string;
};

export type DatabaseProps = {
  /**
   * Cloud SQL instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). Full resource names are
   * accepted and reduced to the last path segment. Immutable — changing
   * it replaces the database.
   */
  instance: string;
  /**
   * Database name inside the instance. If omitted, a unique name is
   * generated from the stack, stage, and logical id. Must start with a
   * letter and contain only letters, numbers, and underscores (1–63
   * characters). Immutable — changing it replaces the database.
   */
  databaseName?: string;
  /**
   * Character set (e.g. `utf8mb4` on MySQL, `UTF8` on PostgreSQL). The
   * engine may reject in-place charset changes (PostgreSQL).
   */
  charset?: string;
  /**
   * Collation (e.g. `utf8mb4_unicode_ci` on MySQL, `en_US.UTF8` on
   * PostgreSQL). The engine may reject in-place collation changes.
   */
  collation?: string;
  /**
   * SQL Server–only settings. Ignored on MySQL and PostgreSQL.
   */
  sqlserverDatabaseDetails?: SqlServerDatabaseDetails;
  /**
   * What to do on destroy. `ABANDON` removes the database from state
   * without calling the Cloud SQL API — useful when the parent instance
   * is being deleted.
   * @default "DELETE"
   */
  deletionPolicy?: DatabaseDeletionPolicy;
};

export type Database = Resource<
  "GCP.SQL.Database",
  DatabaseProps,
  {
    /** Database name inside the instance. */
    databaseName: string;
    /** Cloud SQL instance id. */
    instance: string;
    /** Project id. */
    project: string;
    /** Character set currently on the database. */
    charset: string | undefined;
    /** Collation currently on the database. */
    collation: string | undefined;
    /** SQL Server details, if this is a SQL Server database. */
    sqlserverDatabaseDetails: SqlServerDatabaseDetails | undefined;
    /** SQL Admin self-link. */
    selfLink: string | undefined;
    /** HTTP etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A logical database inside a Cloud SQL instance.
 *
 * Cloud SQL databases have no labels field. `list` enumerates non-system
 * databases on alchemy-labeled instances so `pnpm nuke:gcp` can find
 * leaked rows without dropping `mysql` / `postgres` / `template1`.
 *
 * Changing `instance` or `databaseName` replaces the database. `charset`
 * and `collation` update in place where the engine allows.
 *
 * ### Creating a Database
 * **Example:** Generated name on a Cloud SQL instance
 * ```typescript
 * const instance = yield* GCP.SQL.Instance("AppDb", {
 *   tier: "db-f1-micro",
 *   backupEnabled: false,
 * });
 * const database = yield* GCP.SQL.Database("App", {
 *   instance: instance.instanceName,
 * });
 * ```
 *
 * **Example:** Explicit name, charset, and collation
 * ```typescript
 * const database = yield* GCP.SQL.Database("App", {
 *   instance: instance.instanceName,
 *   databaseName: "app_production",
 *   charset: "utf8mb4",
 *   collation: "utf8mb4_unicode_ci",
 * });
 * ```
 *
 * @resource
 * @category SQL
 */
export const Database = Resource<Database>("GCP.SQL.Database");

export class DatabaseNotResolved extends Data.TaggedError(
  "GCP.SQL.DatabaseNotResolved",
)<{
  instance: string;
  databaseName: string;
}> {}

export class DatabaseStillExists extends Data.TaggedError(
  "GCP.SQL.DatabaseStillExists",
)<{
  instance: string;
  databaseName: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const instanceIdOf = (value: string) => lastSegment(value);

const isUserDatabase = (database: sqladmin.Database) => {
  const name = (database.name ?? "").toLowerCase();
  return name.length > 0 && !SYSTEM_DATABASES.has(name);
};

const hasAlchemyInstanceLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const normalizeText = (value: string | undefined) =>
  (value ?? "").toLowerCase();

const sqlServerKey = (details: SqlServerDatabaseDetails | undefined) =>
  JSON.stringify({
    compatibilityLevel: details?.compatibilityLevel ?? null,
    recoveryModel: (details?.recoveryModel ?? "").toLowerCase(),
  });

const toSqlIdentifier = (name: string) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(next)) next = `d${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/_+$/g, "");
  return next.length > 0 ? next : "database";
};

const toDatabaseName = (
  id: string,
  databaseName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (databaseName !== undefined) return databaseName;
    if (existing !== undefined) return existing;
    return toSqlIdentifier(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
        delimiter: "_",
      }),
    );
  });

const toAttrs = (
  database: sqladmin.Database,
  project: string,
  instance: string,
) => ({
  databaseName: database.name ?? "",
  instance: database.instance ?? instance,
  project: database.project ?? project,
  charset: database.charset,
  collation: database.collation,
  sqlserverDatabaseDetails: database.sqlserverDatabaseDetails,
  selfLink: database.selfLink,
  etag: database.etag,
});

const getByName = (project: string, instance: string, databaseName: string) =>
  sqladmin.getDatabases({ project, instance, database: databaseName }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    recoverIfInstanceMissing(project, instance, () => undefined),
  );

const waitForOperation = (
  project: string,
  operation: sqladmin.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForSqlOperation(project, operation, {
    budget: "10 minutes",
    notFoundOk: options?.notFoundOk,
  });

const waitUntilExists = (
  project: string,
  instance: string,
  databaseName: string,
) =>
  getByName(project, instance, databaseName).pipe(
    Effect.flatMap((database) =>
      database
        ? Effect.succeed(database)
        : Effect.fail(new DatabaseNotResolved({ instance, databaseName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.DatabaseNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  instance: string,
  databaseName: string,
) =>
  getByName(project, instance, databaseName).pipe(
    Effect.flatMap((database) =>
      database === undefined
        ? Effect.void
        : Effect.fail(new DatabaseStillExists({ instance, databaseName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.DatabaseStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toBody = (
  news: DatabaseProps,
  databaseName: string,
  instance: string,
  project: string,
): sqladmin.Database => ({
  name: databaseName,
  instance,
  project,
  charset: news.charset,
  collation: news.collation,
  sqlserverDatabaseDetails: news.sqlserverDatabaseDetails,
});

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseName", "instance", "project", "selfLink"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousInstance = olds?.instance ?? output?.instance;
      const nextInstance = news.instance;
      const previousName = olds?.databaseName ?? output?.databaseName;
      const nextName = news.databaseName ?? previousName;
      const instanceChanged =
        previousInstance !== undefined &&
        instanceIdOf(previousInstance) !== instanceIdOf(nextInstance);
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      if (!instanceChanged && !nameChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: false,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = instanceIdOf(olds?.instance ?? output?.instance ?? "");
      if (instance.length === 0) return undefined;
      const databaseName = yield* toDatabaseName(
        id,
        olds?.databaseName,
        output?.databaseName,
      );
      const existing = yield* getByName(env.project, instance, databaseName);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, instance);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* sqladmin.listInstances
          .items({
            project: env.project,
            maxResults: 1000,
            filter: "instanceType:CLOUD_SQL_INSTANCE",
          })
          .pipe(
            Stream.filter((instance) =>
              hasAlchemyInstanceLabels(instance.settings?.userLabels),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as sqladmin.DatabaseInstance[]),
            ),
          );
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const instanceName = instance.name;
            if (instanceName === undefined || instanceName.length === 0) {
              return Effect.succeed([] as Database["Attributes"][]);
            }
            return sqladmin
              .listDatabases({
                project: env.project,
                instance: instanceName,
              })
              .pipe(
                Effect.map((page) =>
                  (page.items ?? [])
                    .filter(isUserDatabase)
                    .map((database) =>
                      toAttrs(database, env.project, instanceName),
                    ),
                ),
                // The instance may be deleted mid-listing.
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as Database["Attributes"][]),
                ),
                recoverIfInstanceMissing(
                  env.project,
                  instanceName,
                  () => [] as Database["Attributes"][],
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = instanceIdOf(news.instance);
      const databaseName = yield* toDatabaseName(
        id,
        news.databaseName,
        output?.databaseName,
      );

      let current = yield* getByName(env.project, instance, databaseName);

      if (current === undefined) {
        yield* sqladmin
          .insertDatabases({
            project: env.project,
            instance,
            body: toBody(news, databaseName, instance, env.project),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", (error) =>
              getByName(env.project, instance, databaseName).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.void : Effect.fail(error),
                ),
              ),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        current = yield* waitUntilExists(env.project, instance, databaseName);
      }

      const charsetChanged =
        news.charset !== undefined &&
        normalizeText(current.charset) !== normalizeText(news.charset);
      const collationChanged =
        news.collation !== undefined &&
        normalizeText(current.collation) !== normalizeText(news.collation);
      const sqlServerChanged =
        news.sqlserverDatabaseDetails !== undefined &&
        sqlServerKey(current.sqlserverDatabaseDetails) !==
          sqlServerKey(news.sqlserverDatabaseDetails);

      if (charsetChanged || collationChanged || sqlServerChanged) {
        const patched = yield* sqladmin.patchDatabases({
          project: env.project,
          instance,
          database: databaseName,
          body: toBody(news, databaseName, instance, env.project),
        });
        yield* waitForOperation(env.project, patched);
        current = yield* waitUntilExists(env.project, instance, databaseName);
      }

      return toAttrs(current, env.project, instance);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (olds.deletionPolicy === "ABANDON") return;
      const project = output.project;
      const instance = instanceIdOf(output.instance);
      const databaseName = output.databaseName;
      yield* sqladmin
        .deleteDatabases({
          project,
          instance,
          database: databaseName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(project, operation, { notFoundOk: true }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          recoverIfInstanceMissing(project, instance, () => undefined),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      yield* waitUntilGone(project, instance, databaseName);
    }),
  });
