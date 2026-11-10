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
    "PostgresDatabase",
    { tags: ["provider:planetscale", "provider:planetscale:postgres", "live"] },
    () => {
      // Read-only: exercises the real org-wide enumeration code path (with the
      // per-database default-branch hydration) without provisioning anything.
      test.provider("list enumerates databases (read-only)", () =>
        Effect.gen(function* () {
          const provider = yield* Provider.findProvider(Planetscale.PostgresDatabase);
          const all = yield* provider.list();

          expect(Array.isArray(all)).toBe(true);
          for (const db of all) {
            expect(db).toMatchObject({
              id: expect.any(String),
              name: expect.any(String),
              organization: expect.any(String),
              region: { slug: expect.any(String) },
              arch: expect.stringMatching(/^(x86|arm)$/),
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
                const database = yield* Planetscale.PostgresDatabase("ListDatabase", {
                  name: "alchemy-pg-db-list",
                  clusterSize: "PS_10",
                });
                return { database };
              }),
            );

            const provider = yield* Provider.findProvider(Planetscale.PostgresDatabase);
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

      test.provider(
        "create database with minimal settings",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.PostgresDatabase("PostgresDatabaseBasic", {
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
              clusterSize: "PS_10_AWS_X86",
            });

            const branch = yield* Planetscale.waitForBranchReady(
              database.organization,
              database.name,
              "main",
            );

            expect(branch.cluster_name).toEqual("PS_10_AWS_X86");

            yield* stack.destroy();
          }).pipe(logLevel),
        5_000_000,
      );

      test.provider(
        "create database with minimal settings and arm arch",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.PostgresDatabase("PostgresDatabaseBasicArm", {
                  clusterSize: "PS_10",
                  arch: "arm",
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
              arch: "arm",
              clusterSize: "PS_10_AWS_ARM",
            });

            const branch = yield* Planetscale.waitForBranchReady(
              database.organization,
              database.name,
              "main",
            );

            expect(branch.cluster_name).toEqual("PS_10_AWS_ARM");

            yield* stack.destroy();
          }).pipe(logLevel),
        5_000_000,
      );

      test.provider(
        "create, update, and delete database",
        (stack) =>
          Effect.gen(function* () {
            const name = `alchemy-test-postgresql-crud`;

            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.PostgresDatabase("PostgresDatabaseCRUD", {
                  name,
                  region: { slug: "us-east" },
                  clusterSize: "PS_10",
                  defaultBranch: "main",
                  requireApprovalForDeploy: false,
                  restrictBranchRegion: true,
                  productionBranchWebConsole: true,
                });

                return { database };
              }),
            );

            expect(database).toMatchObject({
              id: expect.any(String),
              name,
              organization: expect.any(String),
              state: expect.any(String),
              plan: expect.any(String),
              createdAt: expect.any(String),
              updatedAt: expect.any(String),
              htmlUrl: expect.any(String),
              region: { slug: expect.any(String) },
              clusterSize: "PS_10_AWS_X86",
              defaultBranch: "main",
              requireApprovalForDeploy: false,
              restrictBranchRegion: true,
              productionBranchWebConsole: true,
            });

            const { updatedDatabase } = yield* stack.deploy(
              Effect.gen(function* () {
                const updatedDatabase = yield* Planetscale.PostgresDatabase(
                  "PostgresDatabaseCRUD",
                  {
                    name,
                    clusterSize: "PS_20",
                    requireApprovalForDeploy: true,
                    restrictBranchRegion: false,
                    productionBranchWebConsole: false,
                    defaultBranch: "main",
                  },
                );

                return { updatedDatabase };
              }),
            );

            expect(updatedDatabase).toMatchObject({
              name,
              requireApprovalForDeploy: true,
              restrictBranchRegion: false,
              productionBranchWebConsole: false,
              defaultBranch: "main",
            });

            const branch = yield* Planetscale.waitForBranchReady(
              database.organization,
              database.name,
              "main",
            );

            expect(branch.cluster_name).toEqual("PS_20_AWS_X86");

            yield* stack.destroy();

            yield* waitForDatabaseToBeDeleted(database.name, database.organization);
          }).pipe(logLevel),
        5_000_000,
      );

      test.provider(
        "creates non-main default branch if specified",
        (stack) =>
          Effect.gen(function* () {
            const name = `alchemy-test-postgresql-custom-branch`;
            const defaultBranch = "custom";

            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.PostgresDatabase(
                  "PostgresDatabaseCustomBranch",
                  { name, clusterSize: "PS_10", defaultBranch },
                );

                return { database };
              }),
            );

            expect(database).toMatchObject({ name, defaultBranch });

            const branch = yield* Planetscale.waitForBranchReady(
              database.organization,
              database.name,
              defaultBranch,
            );

            expect(branch.name).toEqual(defaultBranch);
            expect(branch.parent_branch).toEqual("main");
            expect(branch.cluster_name).toEqual("PS_10_AWS_X86");

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
                const database = yield* Planetscale.PostgresDatabase("PostgresDatabaseMigrations", {
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
            const name = `alchemy-test-postgresql-kind`;

            yield* stack.destroy();

            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.MySQLDatabase("MySQLBaselineWrongKind", {
                  name,
                  region: { slug: "us-east" },
                  clusterSize: "PS_10",
                });

                return { database };
              }),
            );

            yield* Planetscale.waitForDatabaseReady(database.organization, name);

            const exit = yield* Effect.exit(
              stack
                .deploy(
                  Effect.gen(function* () {
                    const database = yield* Planetscale.PostgresDatabase("PostgresWrongKind", {
                      name,
                      clusterSize: "PS_10",
                    });

                    return { database };
                  }),
                )
                .pipe(adopt(true)),
            );

            expect(Exit.isFailure(exit)).toBe(true);

            if (Exit.isFailure(exit)) {
              const pretty = Cause.pretty(exit.cause);
              expect(pretty).toContain("mysql");
              expect(pretty).toContain("MySQLDatabase");
            }

            yield* stack.destroy();
          }).pipe(logLevel),
        { timeout: 5_000_000, tags: ["provider:planetscale:mysql"] },
      );

      test.provider(
        "adopt with wrong arch should trigger replace",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            // Create a database with arm
            const { database } = yield* stack.deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.PostgresDatabase("PostgresDatabaseWrongArch", {
                  arch: "arm",
                  clusterSize: "PS_10",
                });

                return { database };
              }),
            );

            expect(database.arch).toEqual("arm");

            // Now try to adopt it with a different arch — should replace
            const { newDatabase } = yield* stack.deploy(
              Effect.gen(function* () {
                const newDatabase = yield* Planetscale.PostgresDatabase(
                  "PostgresDatabaseWrongArch",
                  { arch: "x86", clusterSize: "PS_10" },
                );
                return { newDatabase };
              }),
            );

            expect(newDatabase.id).not.toBe(database.id);

            yield* stack.destroy();

            yield* waitForDatabaseToBeDeleted(database.name, database.organization);
            yield* waitForDatabaseToBeDeleted(newDatabase.name, newDatabase.organization);
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
                const database = yield* Planetscale.PostgresDatabase(
                  "PostgresDatabaseRetainRemoval",
                  { region: { slug: "us-east" }, clusterSize: "PS_10" },
                ).pipe(RemovalPolicy.retain(true));

                return { database };
              }),
            );

            // Verify database exists
            yield* Planetscale.waitForDatabaseReady(database.organization, database.name);

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
            expect(live.kind).toEqual("postgresql");

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
            const name = `${stack.stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-pg-protect`;
            const { organization } = yield* yield* Planetscale.Credentials;

            const program = (deletionProtection: boolean, region?: string) =>
              Effect.gen(function* () {
                const database = yield* Planetscale.PostgresDatabase(
                  "PostgresDatabaseDeletionProtection",
                  {
                    name,
                    clusterSize: "PS_5",
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
