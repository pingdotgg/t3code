import * as Planetscale from "@alchemy.run/planetscale";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ps from "@distilled.cloud/planetscale";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Data, Schedule } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Planetscale.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixturesDir = `${import.meta.dirname}/fixtures`;

describe
  .skipIf(!process.env.PLANETSCALE_TEST)
  .concurrent(
    "MySQLDatabase",
    { tags: ["provider:planetscale", "provider:planetscale:mysql", "live"] },
    () => {
      // Read-only: exercises the real org-wide enumeration code path without
      // provisioning anything (PlanetScale provisioning is extremely slow).
      test.provider("list enumerates databases (read-only)", () =>
        Effect.gen(function* () {
          const provider = yield* Provider.findProvider(Planetscale.MySQLDatabase);
          const all = yield* provider.list();

          expect(Array.isArray(all)).toBe(true);
          for (const db of all) {
            expect(db).toMatchObject({
              id: expect.any(String),
              name: expect.any(String),
              organization: expect.any(String),
              region: { slug: expect.any(String) },
            });
          }
        }).pipe(logLevel),
      );

      // Deploy-and-find coverage, opt-in only (slow provisioning).
      test.provider.skipIf(!process.env.PLANETSCALE_DEPLOY_TEST)(
        "list finds a freshly deployed database",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.MySQLDatabase("ListDatabase", {
                  name: "alchemy-mysql-db-list",
                  clusterSize: "PS_10",
                });
                return { database };
              }),
            );

            const provider = yield* Provider.findProvider(Planetscale.MySQLDatabase);
            const all = yield* provider.list();

            expect(
              all.some(
                (db) => db.organization === database.organization && db.name === database.name,
              ),
            ).toBe(true);

            yield* stack.destroy();
          }).pipe(logLevel),
        5_000_000,
      );

      test.provider("create database with minimal settings", (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.MySQLDatabase("MySQLDatabaseBasic", {
                clusterSize: "PS_10",
              });

              return { database };
            }),
          );

          expect(database).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            organization: expect.any(String),
            state: expect.any(String),
            defaultBranch: "main",
            plan: expect.any(String),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            htmlUrl: expect.any(String),
            region: { slug: expect.any(String) },
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

      test.provider(
        "create, update, and delete database",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.MySQLDatabase("MySQLDatabaseCRUD", {
                  region: { slug: "us-east" },
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

                return { database };
              }),
            );

            expect(database).toMatchObject({
              id: expect.any(String),
              name: expect.any(String),
              organization: expect.any(String),
              state: expect.any(String),
              plan: expect.any(String),
              createdAt: expect.any(String),
              updatedAt: expect.any(String),
              htmlUrl: expect.any(String),
              region: { slug: expect.any(String) },
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
                const updatedDatabase = yield* Planetscale.MySQLDatabase("MySQLDatabaseCRUD", {
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
                });

                return { updatedDatabase };
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
        5_000_000,
      );

      test.provider(
        "reconciles replicas in place via keyspace resize",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.MySQLDatabase("MySQLDatabaseReplicas", {
                  clusterSize: "PS_10",
                  replicas: 3,
                });
                return { database };
              }),
            );

            // PS_10 includes 2 replicas; the third is added in place via a
            // keyspace resize request after creation.
            expect(database.replicas).toEqual(3);

            const keyspaces = yield* ps.listKeyspaces({
              organization: database.organization,
              database: database.name,
              branch: "main",
            });
            const keyspace = keyspaces.data.find((x) => x.name === database.name);
            expect(keyspace?.replicas).toEqual(3);
            expect(keyspace?.extra_replicas).toEqual(1);

            // Scale back down — must resize in place, never replace.
            const { updatedDatabase } = yield* stack.deploy(
              Effect.gen(function* () {
                const updatedDatabase = yield* Planetscale.MySQLDatabase("MySQLDatabaseReplicas", {
                  clusterSize: "PS_10",
                  replicas: 2,
                });
                return { updatedDatabase };
              }),
            );

            expect(updatedDatabase.id).toEqual(database.id);
            expect(updatedDatabase.replicas).toEqual(2);

            yield* stack.destroy();

            yield* waitForDatabaseToBeDeleted(database.name, database.organization);
          }).pipe(logLevel),
        5_000_000,
      );

      test.provider(
        "creates non-main default branch if specified",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.MySQLDatabase("MySQLDatabaseCustomBranch", {
                  clusterSize: "PS_10",
                  defaultBranch: "custom",
                });

                return { database };
              }),
            );

            expect(database).toMatchObject({ defaultBranch: "custom" });

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
                const database = yield* Planetscale.MySQLDatabase("MySQLDatabaseMigrations", {
                  clusterSize: "PS_10",
                  migrations: `${fixturesDir}/migrations`,
                  importFiles: [importFile],
                });

                return { database };
              }),
            );

            expect(database.migrationsTable).toEqual("__alchemy_migrations");
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
                const database = yield* Planetscale.PostgresDatabase("PgBaselineWrongKind", {
                  region: { slug: "us-east" },
                  clusterSize: "PS_10",
                  arch: "arm", // arm is slightly faster
                });

                return { database };
              }),
            );

            yield* Planetscale.waitForDatabaseReady(database.organization, database.name);
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
        { timeout: 5_000_000, tags: ["provider:planetscale:postgres"] },
      );

      test.provider(
        "database with RemovalPolicy.retain(true) should not be deleted via API",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.MySQLDatabase("MySQLDatabaseRetainRemoval", {
                  region: { slug: "us-east" },
                  clusterSize: "PS_10",
                }).pipe(RemovalPolicy.retain(true));

                return { database };
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

            yield* Planetscale.waitForDatabaseReady(database.organization, database.name);

            // Verify database still exists (was not deleted via API)
            const live = yield* ps.getDatabase({
              organization: database.organization,
              database: database.name,
            });

            // Database should still exist
            expect(live.name).toEqual(database.name);
            expect(live.state).toEqual("ready");
            expect(live.kind).toEqual("mysql");

            // Clean up manually for the test
            yield* ps
              .deleteDatabase({ organization: database.organization, database: database.name })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
          }).pipe(logLevel),
        5_000_000,
      );

      test.provider(
        "deletionProtection blocks destroy until it is turned off",
        (stack) =>
          Effect.gen(function* () {
            const name = `${stack.stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-mysql-protect`;
            const { organization } = yield* yield* Planetscale.Credentials;

            const program = (deletionProtection: boolean, region?: string) =>
              Effect.gen(function* () {
                const database = yield* Planetscale.MySQLDatabase(
                  "MySQLDatabaseDeletionProtection",
                  {
                    name,
                    clusterSize: "PS_10",
                    deletionProtection,
                    ...(region ? { region: { slug: region } } : {}),
                  },
                );
                return { database };
              });
            const deploy = (deletionProtection: boolean) =>
              stack.deploy(program(deletionProtection));

            yield* Effect.gen(function* () {
              // Inside the cleanup scope: state left by an interrupted run
              // can still point at a protected database, which makes this
              // destroy fail.
              yield* stack.destroy();

              const { database } = yield* deploy(true);
              expect(database.deletionProtection).toBe(true);

              const live = yield* ps.getDatabase({
                organization,
                database: name,
              });
              expect(live.deletion_protected).toBe(true);

              // Create-first replacement under the same explicit name would
              // converge onto the old database and then delete it, so the
              // plan must refuse a region change that keeps the name.
              const replacement = yield* Effect.exit(
                stack.plan(
                  program(true, database.region.slug === "eu-west" ? "us-east" : "eu-west"),
                ),
              );
              expect(Exit.isFailure(replacement)).toBe(true);
              if (Exit.isFailure(replacement)) {
                expect(Cause.pretty(replacement.cause)).toContain("requires a new database");
              }

              const exit = yield* Effect.exit(stack.destroy());
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("deletionProtection: false");
              }

              const stillThere = yield* ps.getDatabase({
                organization,
                database: name,
              });
              expect(stillThere.id).toEqual(database.id);

              const { database: unprotected } = yield* deploy(false);
              expect(unprotected.deletionProtection).toBe(false);

              yield* stack.destroy();

              yield* waitForDatabaseToBeDeleted(name, organization);
            }).pipe(
              // Registered before the first destroy and deploy so a failed
              // run never leaves a protected database behind; a failed
              // cleanup fails the test.
              Effect.ensuring(deleteTestDatabase(organization, name).pipe(Effect.orDie)),
            );
          }).pipe(logLevel),
        5_000_000,
      );
    },
  );

const waitForDatabaseToBeDeleted = Effect.fn(function* (database: string, organization: string) {
  yield* ps
    .getDatabase({
      organization,
      database,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists => e instanceof DatabaseStillExists,
        // Bounded so a database that never disappears fails the wait
        // (after about 90 seconds) instead of hanging test cleanup.
        schedule: Schedule.spaced("2 seconds"),
        times: 45,
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}

/**
 * Turns deletion protection off and deletes a test database by name, then
 * waits until it is gone. A database that does not exist is a no-op.
 */
const deleteTestDatabase = Effect.fn(function* (organization: string, database: string) {
  const live = yield* ps
    .getDatabase({ organization, database })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  if (!live) return;
  if (live.deletion_protected) {
    yield* ps.updateDatabaseSettings({
      organization,
      database,
      deletion_protected: false,
    });
  }
  yield* ps
    .deleteDatabase({ organization, database })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
  yield* waitForDatabaseToBeDeleted(database, organization);
});
