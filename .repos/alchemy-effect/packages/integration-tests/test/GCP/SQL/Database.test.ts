import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import type { StackServices } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const testOptions = {
  providers: GCP.providers() as Layer.Layer<GCP.ProviderRequirements, never, StackServices>,
};
const { test, beforeAll, afterAll } = Test.make(testOptions);

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Runs against an existing Cloud SQL instance (creating one takes well over
// 5 minutes); set GCP_SQL_INSTANCE to its name.
const sqlInstance = process.env.GCP_SQL_INSTANCE || process.env.GCP_TEST_SQL_INSTANCE;
const runLifecycle = !!sqlInstance && !process.env.FAST;

const waitUntilGone = (instance: string, databaseName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      sqladmin
        .getDatabases({
          project,
          instance,
          database: databaseName,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

test.provider(
  "getDatabases on a missing instance fails with SqlInstanceNotAuthorized",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getDatabases({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
          database: "alchemy_db_does_not_exist",
        }),
      );
      // Cloud SQL hides unknown instances behind 403 rather than 404.
      expect(error._tag).toBe("SqlInstanceNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider(
  "listDatabases on a missing instance fails with SqlInstanceNotAuthorized",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.listDatabases({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
        }),
      );
      expect(error._tag).toBe("SqlInstanceNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql database",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const instance = sqlInstance!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Database("App", {
            instance,
          });
        }),
      );

      expect(created.databaseName).toEqual(expect.any(String));
      expect(created.databaseName).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);

      const fetched = yield* sqladmin.getDatabases({
        project: created.project,
        instance: created.instance,
        database: created.databaseName,
      });
      expect(fetched.name).toEqual(created.databaseName);
      expect(fetched.instance).toEqual(created.instance);

      const live = yield* sqladmin.getInstances({
        project: created.project,
        instance: created.instance,
      });
      const isMysql = (live.databaseVersion ?? "").toUpperCase().startsWith("MYSQL");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Database("App", {
            instance,
            databaseName: created.databaseName,
            charset: isMysql ? "utf8mb4" : created.charset,
            collation: isMysql ? "utf8mb4_unicode_ci" : created.collation,
          });
        }),
      );

      expect(updated.databaseName).toEqual(created.databaseName);
      expect(updated.instance).toEqual(created.instance);
      if (isMysql) {
        expect(updated.charset?.toLowerCase()).toEqual("utf8mb4");
      }

      const refetched = yield* sqladmin.getDatabases({
        project: updated.project,
        instance: updated.instance,
        database: updated.databaseName,
      });
      expect(refetched.name).toEqual(updated.databaseName);
      if (isMysql) {
        expect(refetched.charset?.toLowerCase()).toEqual("utf8mb4");
      }

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.instance, created.databaseName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 120_000 },
);

// Shared-core, zonal, no backups: the cheapest Cloud SQL there is. Both
// allow the Data API so the tests can verify through it.
const MIGRATIONS_PASSWORD = "Alchemy-migrations-test-1";
const migrationsOptions = { providers: GCP.providers() };
const migrationsStack = Core.scratchStack(migrationsOptions, "SqlMigrations", import.meta.filename);

const MigrationsInstances = Effect.gen(function* () {
  const instance = (id: string, databaseVersion: string) =>
    GCP.SQL.Instance(id, {
      databaseVersion,
      edition: "ENTERPRISE",
      tier: "db-f1-micro",
      availabilityType: "ZONAL",
      backup: { enabled: false },
      deletionProtectionEnabled: false,
      dataApiAccess: true,
    });
  const postgres = yield* instance("MigrationsPostgres", "POSTGRES_17");
  const mysql = yield* instance("MigrationsMySql", "MYSQL_8_0");
  const user = (id: string, of: typeof postgres) =>
    GCP.SQL.User(id, {
      instance: of.instanceName,
      password: MIGRATIONS_PASSWORD,
      // Deleting the instance removes it.
      deletionPolicy: "ABANDON",
    });
  const postgresUser = yield* user("MigrationsPostgresUser", postgres);
  const mysqlUser = yield* user("MigrationsMySqlUser", mysql);
  // Where the test's own Data API queries read the password.
  const secret = yield* GCP.SecretManager.LocationsSecret("MigrationsVerifyPassword", {
    location: postgres.region,
  });
  return {
    postgres: postgres.instanceName,
    postgresUser: postgresUser.userName,
    mysql: mysql.instanceName,
    mysqlUser: mysqlUser.userName,
    region: postgres.region,
    secret: secret.name,
  };
});

// Writes `0001_users.sql` into a fresh temp directory; `add` writes later
// migrations into the same directory between deploys.
const migrationsFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-cloudsql-migrations-" });
  const add = (name: string, sql: string) => fs.writeFileString(path.join(dir, name), sql);
  yield* add("0001_users.sql", "CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL);");
  return { dir, add };
});

describe.skipIf(!!process.env.FAST)(
  "Database migrations",
  { tags: ["provider:gcp", "provider:gcp:sql", "live"] },
  () => {
    let shared: {
      postgres: string;
      postgresUser: string;
      mysql: string;
      mysqlUser: string;
      region: string;
      secret: string;
    };

    beforeAll(
      Effect.gen(function* () {
        shared = yield* migrationsStack.deploy(MigrationsInstances);
        const data = yield* Effect.sync(() =>
          Buffer.from(MIGRATIONS_PASSWORD, "utf8").toString("base64"),
        );
        yield* Core.withProviders(
          secretmanager.addVersionProjectsLocationsSecrets({
            parent: shared.secret,
            body: { payload: { data } },
          }),
          migrationsOptions,
          "SqlMigrations",
        );
      }),
      { timeout: 1_800_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(migrationsStack.destroy(), { timeout: 1_200_000 });

    /** Applied migration names, read out-of-band through the Data API. */
    const appliedMigrations = (instance: string, database: string, user: string) =>
      Effect.gen(function* () {
        const { project } = yield* GcpEnvironment.current;
        const response = yield* sqladmin.executeSqlInstances({
          project,
          instance,
          body: {
            database,
            user,
            passwordSecretVersion: `${shared.secret}/versions/latest`,
            sqlStatement: "SELECT name FROM __alchemy_migrations ORDER BY id",
          },
        });
        expect(response.status?.message).toBeUndefined();
        return (response.results?.[0]?.rows ?? []).map((row) => row.values?.[0]?.value);
      });

    const stagedSecretGone = (instance: string, database: string) =>
      Effect.gen(function* () {
        const { project } = yield* GcpEnvironment.current;
        const error = yield* Effect.flip(
          secretmanager.getProjectsLocationsSecrets({
            name: `projects/${project}/locations/${shared.region}/secrets/alchemy-migrations-${instance}-${database}`,
          }),
        );
        expect(error._tag).toEqual("NotFound");
      });

    const migrationsLifecycle = (options: {
      engine: "postgres" | "mysql";
      transport: GCP.SQL.MigrationsTransport | undefined;
    }) =>
      Effect.fn(function* (stack: Core.ScratchStack) {
        const instance = options.engine === "postgres" ? shared.postgres : shared.mysql;
        const user = options.engine === "postgres" ? shared.postgresUser : shared.mysqlUser;
        const migrations = yield* migrationsFixture;
        const database = GCP.SQL.Database("App", {
          instance,
          migrations: migrations.dir,
          migrationsTransport: options.transport,
          migrationsUser: user,
          migrationsPassword: MIGRATIONS_PASSWORD,
        });

        yield* stack.destroy();

        const created = yield* stack.deploy(database);
        expect(created.migrationsTable).toEqual("__alchemy_migrations");
        expect(Object.keys(created.migrationsHashes)).toEqual(["0001_users.sql"]);
        expect(yield* appliedMigrations(instance, created.databaseName, user)).toEqual([
          "0001_users.sql",
        ]);
        yield* stagedSecretGone(instance, created.databaseName);

        // Nothing changed: the next deploy has nothing to apply.
        const unchanged = yield* stack.plan(database);
        expect(unchanged.resources.App?.action).toEqual("noop");

        yield* migrations.add(
          "0002_posts.sql",
          "CREATE TABLE posts (id INT PRIMARY KEY, title TEXT NOT NULL);",
        );
        const pending = yield* stack.plan(database);
        expect(pending.resources.App?.action).toEqual("update");

        const updated = yield* stack.deploy(database);
        expect(updated.databaseName).toEqual(created.databaseName);
        expect(Object.keys(updated.migrationsHashes).sort()).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
        expect(yield* appliedMigrations(instance, updated.databaseName, user)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);

        yield* stack.destroy();
        expect(yield* waitUntilGone(instance, updated.databaseName)).toEqual("gone");
      });

    for (const engine of ["postgres", "mysql"] as const) {
      const label = engine === "postgres" ? "PostgreSQL" : "MySQL";
      test.provider(
        `${label} applies migrations over the Data API, then only pending ones`,
        (stack) => migrationsLifecycle({ engine, transport: undefined })(stack),
        { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 600_000 },
      );

      test.provider(
        `${label} applies migrations through the Cloud SQL connector, then only pending ones`,
        (stack) => migrationsLifecycle({ engine, transport: "connector" })(stack),
        { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 600_000 },
      );
    }
  },
);
