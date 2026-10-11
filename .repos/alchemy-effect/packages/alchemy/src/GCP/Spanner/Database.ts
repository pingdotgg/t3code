import * as spanner from "@distilled.cloud/gcp/spanner_v1";
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
import { waitForOperation } from "./operations.ts";

const DEFAULT_DIALECT = "GOOGLE_STANDARD_SQL";
const MAX_DATABASE_ID_LENGTH = 30;

export type DatabaseDialect =
  | spanner.DatabaseDatabaseDialectEnum
  | (string & {});

export type EncryptionConfig = {
  /**
   * Cloud KMS key
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable — changing it replaces the database.
   */
  kmsKeyName?: string;
  /**
   * KMS keys covering every region of the instance config. Immutable —
   * changing them replaces the database.
   */
  kmsKeyNames?: string[];
};

export type DatabaseProps = {
  /**
   * Parent instance id or full name
   * (`projects/{project}/instances/{instance}`). Immutable — changing it
   * replaces the database.
   */
  instance: string;
  /**
   * Database id (the `{database}` segment of
   * `projects/{project}/instances/{instance}/databases/{database}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `^[a-z][-a-z0-9]*[a-z0-9]$` (2–30
   * characters). Immutable — changing it replaces the database.
   */
  databaseId?: string;
  /**
   * SQL dialect. Immutable — changing it replaces the database.
   * @default "GOOGLE_STANDARD_SQL"
   */
  databaseDialect?: DatabaseDialect;
  /**
   * Extra DDL statements run atomically with create. Immutable —
   * changing them replaces the database.
   */
  extraStatements?: string[];
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * database.
   */
  encryptionConfig?: EncryptionConfig;
  /**
   * Drop protection. Alchemy defaults to disabled so `destroy` can drop
   * the database. Delete disables protection first when it is on.
   * @default false
   */
  enableDropProtection?: boolean;
};

export type Database = Resource<
  "GCP.Spanner.Database",
  DatabaseProps,
  {
    /** Full resource name `projects/{project}/instances/{instance}/databases/{database}`. */
    name: string;
    /** Database id (last path segment). */
    databaseId: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** SQL dialect. */
    databaseDialect: string | undefined;
    /** Whether drop protection is enabled. */
    enableDropProtection: boolean;
    /** Current database state (`CREATING`, `READY`, `READY_OPTIMIZING`). */
    state: string | undefined;
    /** Version retention period (e.g. `"1h"`). */
    versionRetentionPeriod: string | undefined;
    /** Earliest PITR timestamp, if available. */
    earliestVersionTime: string | undefined;
    /** Default leader region, if set. */
    defaultLeader: string | undefined;
    /** CMEK config, if any. */
    encryptionConfig: EncryptionConfig | undefined;
    /** Whether an update is in flight. */
    reconciling: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Spanner database inside an instance.
 *
 * Spanner databases have no labels field. `list` enumerates databases on
 * alchemy-labeled instances so `pnpm nuke:gcp` can find leaked rows.
 * Changing `instance`, `databaseId`, dialect, CMEK, or extra DDL
 * replaces the database. Drop protection updates in place.
 *
 * ### Creating a Database
 * **Example:** Generated name on a Spanner instance
 * ```typescript
 * const instance = yield* GCP.Spanner.Instance("App", {});
 * const database = yield* GCP.Spanner.Database("AppDb", {
 *   instance: instance.instanceId,
 * });
 * ```
 *
 * **Example:** Explicit id, dialect, and extra DDL
 * ```typescript
 * const database = yield* GCP.Spanner.Database("AppDb", {
 *   instance: instance.instanceId,
 *   databaseId: "appdb",
 *   extraStatements: [
 *     "CREATE TABLE Users (UserId INT64 NOT NULL) PRIMARY KEY (UserId)",
 *   ],
 * });
 * ```
 *
 * ### Querying
 * **Example:** Run SQL
 * ```typescript
 * const executeSql = yield* GCP.Spanner.ExecuteSql(database);
 * const result = yield* executeSql({ sql: "SELECT 1 AS n" });
 * ```
 *
 * ### Reading Schema
 * **Example:** Fetch live DDL
 * ```typescript
 * const getDdl = yield* GCP.Spanner.GetDdl(database);
 * const { statements } = yield* getDdl();
 * ```
 *
 * @resource
 * @category Spanner
 */
export const Database = Resource<Database>("GCP.Spanner.Database");

export class DatabaseNotResolved extends Data.TaggedError(
  "GCP.Spanner.DatabaseNotResolved",
)<{
  name: string;
}> {}

export class DatabaseNotReady extends Data.TaggedError(
  "GCP.Spanner.DatabaseNotReady",
)<{
  name: string;
  state: string;
}> {}

export class DatabaseStillExists extends Data.TaggedError(
  "GCP.Spanner.DatabaseStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const instanceIdOf = (value: string) => lastSegment(value);

const normalizeDialect = (value: string | undefined) => {
  const next = (value ?? DEFAULT_DIALECT).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? DEFAULT_DIALECT : next;
};

const resourceName = (
  project: string,
  instanceId: string,
  databaseId: string,
) => `projects/${project}/instances/${instanceId}/databases/${databaseId}`;

const instanceName = (project: string, instanceId: string) =>
  `projects/${project}/instances/${instanceId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const databasesAt = parts.lastIndexOf("databases");
  const instancesAt = parts.lastIndexOf("instances");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    instanceId:
      instancesAt >= 0 && parts[instancesAt + 1] ? parts[instancesAt + 1]! : "",
    databaseId:
      databasesAt >= 0 && parts[databasesAt + 1]
        ? parts[databasesAt + 1]!
        : lastSegment(name),
  };
};

const toSpannerId = (name: string) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  next = next.replace(/^-+/, "").replace(/-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `d${next}`;
  next = next.slice(0, MAX_DATABASE_ID_LENGTH).replace(/-+$/g, "");
  if (next.length < 2) next = `${next}xx`.slice(0, MAX_DATABASE_ID_LENGTH);
  return next;
};

const toDatabaseId = (
  id: string,
  databaseId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (databaseId !== undefined) return databaseId;
    if (existing !== undefined) return existing;
    return toSpannerId(
      yield* createPhysicalName({
        id,
        maxLength: MAX_DATABASE_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

const createStatementOf = (databaseId: string, dialect: string) =>
  dialect === "POSTGRESQL"
    ? `CREATE DATABASE "${databaseId}"`
    : `CREATE DATABASE \`${databaseId}\``;

const encryptionOf = (
  config: spanner.EncryptionConfig | undefined,
): EncryptionConfig | undefined => {
  if (config === undefined) return undefined;
  if (
    (config.kmsKeyName === undefined || config.kmsKeyName.length === 0) &&
    (config.kmsKeyNames === undefined || config.kmsKeyNames.length === 0)
  ) {
    return undefined;
  }
  return {
    kmsKeyName: config.kmsKeyName,
    kmsKeyNames: config.kmsKeyNames,
  };
};

const encryptionKey = (config: EncryptionConfig | undefined) =>
  JSON.stringify({
    kmsKeyName: config?.kmsKeyName ?? "",
    kmsKeyNames: [...(config?.kmsKeyNames ?? [])].sort(),
  });

const extraKey = (statements: string[] | undefined) =>
  JSON.stringify(statements ?? []);

const toAttrs = (
  database: spanner.Database,
  project: string,
): Database["Attributes"] => {
  const name = database.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    databaseId: parsed.databaseId,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    databaseDialect: database.databaseDialect,
    enableDropProtection: database.enableDropProtection === true,
    state: database.state,
    versionRetentionPeriod: database.versionRetentionPeriod,
    earliestVersionTime: database.earliestVersionTime,
    defaultLeader: database.defaultLeader,
    encryptionConfig: encryptionOf(database.encryptionConfig),
    reconciling: database.reconciling,
    createTime: database.createTime,
  };
};

const getByName = (name: string) =>
  spanner
    .getProjectsInstancesDatabases({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((database) =>
      database
        ? Effect.succeed(database)
        : Effect.fail(new DatabaseNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Spanner.DatabaseNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const isReadyState = (state: string | undefined) =>
  state === "READY" || state === "READY_OPTIMIZING";

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (database): database is spanner.Database => database !== undefined,
      () => new DatabaseNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (database) => isReadyState(database.state),
      (database) =>
        new DatabaseNotReady({
          name,
          state: database.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Spanner.DatabaseNotReady" ||
        error._tag === "GCP.Spanner.DatabaseNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((database) =>
      database === undefined
        ? Effect.void
        : Effect.fail(new DatabaseStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Spanner.DatabaseStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
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

const listAlchemyInstances = (project: string) =>
  spanner.listProjectsInstances
    .pages({
      parent: `projects/${project}`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
      Stream.filter((instance) =>
        Object.keys(instance.labels ?? {}).some((key) =>
          key.startsWith(ALCHEMY_LABEL_PREFIX),
        ),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as spanner.Instance[]),
      ),
    );

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["name", "databaseId", "instanceId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousInstance = olds?.instance ?? output?.instanceId;
      const nextInstance = news.instance;
      const previousId = olds?.databaseId ?? output?.databaseId;
      const nextId = news.databaseId ?? previousId;
      const previousDialect = normalizeDialect(
        olds?.databaseDialect ?? output?.databaseDialect,
      );
      const nextDialect = normalizeDialect(
        news.databaseDialect ?? output?.databaseDialect,
      );
      const previousKms = encryptionKey(
        olds?.encryptionConfig ?? output?.encryptionConfig,
      );
      const nextKms = encryptionKey(
        news.encryptionConfig ?? output?.encryptionConfig,
      );
      const extraChanged =
        olds?.extraStatements !== undefined &&
        news.extraStatements !== undefined &&
        extraKey(olds.extraStatements) !== extraKey(news.extraStatements);

      const instanceChanged =
        previousInstance !== undefined &&
        instanceIdOf(previousInstance) !== instanceIdOf(nextInstance);
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        previousId !== nextId;

      const replace =
        instanceChanged ||
        idChanged ||
        previousDialect !== nextDialect ||
        previousKms !== nextKms ||
        extraChanged;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          !instanceChanged && previousId !== undefined && nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = instanceIdOf(
        olds?.instance ?? output?.instanceId ?? "",
      );
      if (instanceId.length === 0) return undefined;
      const databaseId = yield* toDatabaseId(
        id,
        olds?.databaseId,
        output?.databaseId,
      );
      const name =
        output?.name ?? resourceName(env.project, instanceId, databaseId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* listAlchemyInstances(env.project);
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const parent = instance.name;
            if (parent === undefined || parent.length === 0) {
              return Effect.succeed([] as Database["Attributes"][]);
            }
            return spanner.listProjectsInstancesDatabases
              .pages({
                parent,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.databases ?? []),
                ),
                Stream.map((database) => toAttrs(database, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as Database["Attributes"][]),
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = instanceIdOf(news.instance);
      const databaseId = yield* toDatabaseId(
        id,
        news.databaseId,
        output?.databaseId,
      );
      const name = resourceName(env.project, instanceId, databaseId);
      const dialect = normalizeDialect(news.databaseDialect);
      const desiredProtection = news.enableDropProtection === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* spanner
          .createProjectsInstancesDatabases({
            parent: instanceName(env.project, instanceId),
            body: {
              createStatement: createStatementOf(databaseId, dialect),
              extraStatements: news.extraStatements,
              encryptionConfig: news.encryptionConfig,
              databaseDialect:
                dialect === DEFAULT_DIALECT ? undefined : dialect,
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

      if (!isReadyState(current.state)) {
        current = yield* waitUntilReady(name);
      }

      const observedProtection = current.enableDropProtection === true;
      if (observedProtection !== desiredProtection) {
        const patched = yield* retryConcurrentChanges(
          spanner.patchProjectsInstancesDatabases({
            name,
            updateMask: "enableDropProtection",
            body: {
              name,
              enableDropProtection: desiredProtection,
            },
          }),
        );
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getByName(output.name);
      if (current === undefined) return;

      if (current.enableDropProtection === true) {
        const patched = yield* retryConcurrentChanges(
          spanner.patchProjectsInstancesDatabases({
            name: output.name,
            updateMask: "enableDropProtection",
            body: {
              name: output.name,
              enableDropProtection: false,
            },
          }),
        );
        yield* waitForOperation(patched);
      }

      yield* retryConcurrentChanges(
        spanner
          .dropDatabaseProjectsInstancesDatabases({ database: output.name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void)),
      );
      yield* waitUntilGone(output.name);
    }),
  });
