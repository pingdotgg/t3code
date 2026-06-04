import { adopt } from "@/AdoptPolicy";
import * as Planetscale from "@/Planetscale";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import * as Test from "@/Test/Vitest";
import * as ops from "@distilled.cloud/planetscale/Operations";
import { describe, expect } from "@effect/vitest";
import { Data, Schedule } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Planetscale.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixturesDir = `${import.meta.dirname}/fixtures`;

describe.skipIf(!process.env.PLANETSCALE_TEST)(() => {
  test.provider("create database with minimal settings", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { database } = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Planetscale.MySQLDatabase(
            "MySQLDatabaseBasic",
            {
              clusterSize: "PS_10",
            },
          );

          return {
            database,
          };
        }),
      );

      expect(database).toMatchObject({
        kind: "mysql",
        id: expect.any(String),
        name: expect.any(String),
        organization: expect.any(String),
        state: expect.any(String),
        defaultBranch: "main",
        plan: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        htmlUrl: expect.any(String),
        region: {
          slug: expect.any(String),
        },
        clusterSize: "PS_10",
      });

      const branch = yield* Planetscale.waitForBranchReady(
        database.organization,
        database.name,
        "main",
      );

      expect(branch.cluster_name).toEqual("PS_10");

      yield* stack.destroy();
    }).pipe(logLevel),
  );

  test.provider("create, update, and delete database", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { database } = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Planetscale.MySQLDatabase(
            "MySQLDatabaseCRUD",
            {
              region: {
                slug: "us-east",
              },
              clusterSize: "PS_10",
              defaultBranch: "main",
              allowDataBranching: true,
              automaticMigrations: true,
              requireApprovalForDeploy: false,
              restrictBranchRegion: true,
              insightsRawQueries: true,
              productionBranchWebConsole: true,
              migrationFramework: "rails",
              migrationTableName: "schema_migrations",
            },
          );

          return {
            database,
          };
        }),
      );

      expect(database).toMatchObject({
        kind: "mysql",
        id: expect.any(String),
        name: expect.any(String),
        organization: expect.any(String),
        state: expect.any(String),
        plan: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        htmlUrl: expect.any(String),
        region: {
          slug: expect.any(String),
        },
        clusterSize: "PS_10",
        defaultBranch: "main",
        allowDataBranching: true,
        automaticMigrations: true,
        requireApprovalForDeploy: false,
        restrictBranchRegion: true,
        insightsRawQueries: true,
        productionBranchWebConsole: true,
        migrationFramework: "rails",
        migrationTableName: "schema_migrations",
      });

      const { updatedDatabase } = yield* stack.deploy(
        Effect.gen(function* () {
          const updatedDatabase = yield* Planetscale.MySQLDatabase(
            "MySQLDatabaseCRUD",
            {
              clusterSize: "PS_20",
              allowDataBranching: false,
              automaticMigrations: true,
              requireApprovalForDeploy: true,
              restrictBranchRegion: false,
              insightsRawQueries: false,
              productionBranchWebConsole: false,
              defaultBranch: "main",
              migrationFramework: "django",
              migrationTableName: "django_migrations",
            },
          );

          return {
            updatedDatabase,
          };
        }),
      );

      expect(updatedDatabase).toMatchObject({
        allowDataBranching: false,
        automaticMigrations: true,
        requireApprovalForDeploy: true,
        restrictBranchRegion: false,
        insightsRawQueries: false,
        productionBranchWebConsole: false,
        defaultBranch: "main",
        migrationFramework: "django",
        migrationTableName: "django_migrations",
      });

      const branch = yield* Planetscale.waitForBranchReady(
        database.organization,
        database.name,
        "main",
      );

      expect(branch.cluster_name).toEqual("PS_20");

      yield* stack.destroy();

      yield* waitForDatabaseToBeDeleted(database.name, database.organization);
    }).pipe(logLevel),
  );

  test.provider(
    "creates non-main default branch if specified",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase(
              "MySQLDatabaseCustomBranch",
              {
                clusterSize: "PS_10",
                defaultBranch: "custom",
              },
            );

            return {
              database,
            };
          }),
        );

        expect(database).toMatchObject({
          kind: "mysql",
          defaultBranch: "custom",
        });

        const branch = yield* Planetscale.waitForBranchReady(
          database.organization,
          database.name,
          "custom",
        );

        expect(branch.name).toEqual("custom");
        expect(branch.parent_branch).toEqual("main");
        expect(branch.cluster_name).toEqual("PS_10");

        yield* stack.destroy();

        yield* waitForDatabaseToBeDeleted(database.name, database.organization);
      }).pipe(logLevel),
    5_000_000, // must wait on multiple resizes and branch creation
  );

  test.provider(
    "applies migrations and import files",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const importFile = `${fixturesDir}/seed.sql`;
        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase(
              "MySQLDatabaseMigrations",
              {
                clusterSize: "PS_10",
                migrationsDir: `${fixturesDir}/migrations`,
                importFiles: [importFile],
              },
            );

            return {
              database,
            };
          }),
        );

        expect(database.migrationsTable).toEqual("planetscale_migrations");
        expect(database.migrationsHashes["0001_create_widgets.sql"]).toEqual(
          expect.any(String),
        );
        expect(database.importHashes[importFile]).toEqual(expect.any(String));

        yield* stack.destroy();

        yield* waitForDatabaseToBeDeleted(database.name, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "adopt with wrong kind should throw",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.PostgresDatabase(
              "PgBaselineWrongKind",
              {
                region: { slug: "us-east" },
                clusterSize: "PS_10",
                arch: "arm", // arm is slightly faster
              },
            );

            return { database };
          }),
        );

        yield* Planetscale.waitForDatabaseReady(
          database.organization,
          database.name,
        );
        const exit = yield* Effect.exit(
          stack
            .deploy(
              Effect.gen(function* () {
                return yield* Planetscale.MySQLDatabase("MysqlWrongKind", {
                  name: database.name,
                  clusterSize: "PS_10",
                });
              }),
            )
            .pipe(adopt(true)),
        );

        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isFailure(exit)) {
          const pretty = Cause.pretty(exit.cause);

          expect(pretty).toContain("postgresql");
          expect(pretty).toContain("PostgresDatabase");
        }
        yield* stack.destroy();
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "database with RemovalPolicy.retain(true) should not be deleted via API",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase(
              "MySQLDatabaseRetainRemoval",
              {
                region: { slug: "us-east" },
                clusterSize: "PS_10",
              },
            ).pipe(RemovalPolicy.retain(true));

            return {
              database,
            };
          }),
        );

        // Verify database exists
        const readyDatabase = yield* Planetscale.waitForDatabaseReady(
          database.organization,
          database.name,
        );

        expect(readyDatabase.name).toEqual(database.name);

        // When we call destroy, the database should NOT be deleted via API
        yield* stack.destroy();

        yield* Planetscale.waitForDatabaseReady(
          database.organization,
          database.name,
        );

        // Verify database still exists (was not deleted via API)
        const live = yield* ops.getDatabase({
          organization: database.organization,
          database: database.name,
        });

        // Database should still exist
        expect(live.name).toEqual(database.name);
        expect(live.state).toEqual("ready");
        expect(live.kind).toEqual("mysql");

        // Clean up manually for the test
        yield* ops
          .deleteDatabase({
            organization: database.organization,
            database: database.name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }).pipe(logLevel),
    5_000_000,
  );
});

const waitForDatabaseToBeDeleted = Effect.fn(function* (
  database: string,
  organization: string,
) {
  yield* ops
    .getDatabase({
      organization,
      database,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists =>
          e instanceof DatabaseStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
