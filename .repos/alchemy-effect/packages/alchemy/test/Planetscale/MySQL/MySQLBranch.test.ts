import { adopt } from "@/AdoptPolicy";
import * as Planetscale from "@/Planetscale";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import * as Test from "@/Test/Alchemy";
import * as ops from "@distilled.cloud/planetscale/Operations";
import { describe, expect } from "alchemy-test";
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

describe.skipIf(!process.env.PLANETSCALE_TEST).concurrent("MySQLBranch", () => {
  test.provider(
    "adopts existing branch when adopt is true",
    (stack) =>
      Effect.gen(function* () {
        const dbName = "alchemy-branch-adopt-true";
        const branchName = "adopted";

        yield* stack.destroy();

        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            });

            return { database };
          }),
        );

        yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          "main",
        );
        yield* deleteBranchIfExists(database.organization, dbName, branchName);

        yield* ops.createBranch({
          organization: database.organization,
          database: dbName,
          name: branchName,
          parent_branch: "main",
        });
        yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          branchName,
        );

        const { branch } = yield* stack
          .deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.MySQLDatabase("Database", {
                name: dbName,
                region: { slug: "us-east" },
                clusterSize: "PS_10",
              });
              const branch = yield* Planetscale.MySQLBranch("AdoptedBranch", {
                name: branchName,
                database,
                parentBranch: "main",
                isProduction: false,
              });

              return { database, branch };
            }),
          )
          .pipe(adopt(true));

        expect(branch).toMatchObject({
          name: branchName,
          organization: database.organization,
          database: dbName,
          parentBranch: "main",
          production: false,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          htmlUrl: expect.any(String),
          region: { slug: expect.any(String) },
        });

        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(dbName, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "errors on existing branch when adopt is false",
    (stack) =>
      Effect.gen(function* () {
        const dbName = "alchemy-branch-adopt-false";
        const branchName = "existing";

        yield* stack.destroy();

        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            });

            return { database };
          }),
        );

        yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          "main",
        );
        yield* deleteBranchIfExists(database.organization, dbName, branchName);

        yield* ops.createBranch({
          organization: database.organization,
          database: dbName,
          name: branchName,
          parent_branch: "main",
        });
        yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          branchName,
        );

        const exit = yield* stack
          .deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.MySQLDatabase("Database", {
                name: dbName,
                region: { slug: "us-east" },
                clusterSize: "PS_10",
              });
              const branch = yield* Planetscale.MySQLBranch("ExistingBranch", {
                name: branchName,
                database,
                parentBranch: "main",
                isProduction: false,
              });

              return { database, branch };
            }),
          )
          .pipe(Effect.exit);

        yield* deleteBranchIfExists(database.organization, dbName, branchName);
        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(dbName, database.organization);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const pretty = Cause.pretty(exit.cause);
          expect(pretty).toContain("Cannot adopt resource");
          expect(pretty).toContain("Planetscale.MySQLBranch");
        }
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "can create branch with backup",
    (stack) =>
      Effect.gen(function* () {
        const dbName = "alchemy-branch-backup";
        const branchName = "restored";

        yield* stack.destroy();

        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            });

            return { database };
          }),
        );

        yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          "main",
        );
        yield* deleteBranchIfExists(database.organization, dbName, branchName);

        const backup = yield* ops.createBackup({
          organization: database.organization,
          database: dbName,
          branch: "main",
          name: "alchemy-branch-backup-source",
          retention_unit: "hour",
          retention_value: 1,
        });
        yield* waitForBackupSuccess(
          database.organization,
          dbName,
          "main",
          backup.id,
        );

        const { branch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("RestoredBranch", {
              name: branchName,
              database,
              parentBranch: "main",
              isProduction: true,
              backupId: backup.id,
              clusterSize: "PS_10",
            });

            return { database, branch };
          }),
        );

        expect(branch).toMatchObject({
          name: branchName,
          database: dbName,
          parentBranch: "main",
          production: true,
        });

        const live = yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          branchName,
        );
        expect(live.name).toEqual(branchName);
        expect(live.production).toBe(true);
        expect(live.cluster_name).toEqual("PS_10");

        yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("RestoredBranch", {
              name: branchName,
              database,
              parentBranch: "main",
              isProduction: false,
            });

            return { database, branch };
          }),
        );

        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(dbName, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "can enable and disable safe migrations",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { database, branch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("Branch", {
              database,
              parentBranch: "main",
              isProduction: true,
              clusterSize: "PS_10",
              safeMigrations: true,
            });

            return { database, branch };
          }),
        );

        const enabled = yield* ops.getBranch({
          organization: database.organization,
          database: database.name,
          branch: branch.name,
        });
        expect(enabled.production).toBe(true);
        expect(enabled.safe_migrations).toBe(true);

        const { updatedBranch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              clusterSize: "PS_10",
            });
            const updatedBranch = yield* Planetscale.MySQLBranch("Branch", {
              database,
              parentBranch: "main",
              isProduction: true,
              clusterSize: "PS_10",
              safeMigrations: false,
            });

            return { database, updatedBranch };
          }),
        );

        expect(updatedBranch.name).toEqual(branch.name);

        const disabled = yield* ops.getBranch({
          organization: database.organization,
          database: database.name,
          branch: branch.name,
        });
        expect(disabled.safe_migrations).toBe(false);

        yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("Branch", {
              database,
              parentBranch: "main",
              isProduction: false,
            });

            return { database, branch };
          }),
        );

        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(database.name, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "can update cluster size",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { database, branch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("Branch", {
              database,
              parentBranch: "main",
              isProduction: true,
              clusterSize: "PS_10",
            });

            return { database, branch };
          }),
        );

        const initial = yield* Planetscale.waitForBranchReady(
          database.organization,
          database.name,
          branch.name,
        );
        expect(initial.cluster_name).toEqual("PS_10");

        const { resizedBranch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              clusterSize: "PS_10",
            });
            const resizedBranch = yield* Planetscale.MySQLBranch("Branch", {
              database,
              parentBranch: "main",
              isProduction: true,
              clusterSize: "PS_20",
            });

            return { database, resizedBranch };
          }),
        );

        expect(resizedBranch.name).toEqual(branch.name);

        const resized = yield* Planetscale.waitForBranchReady(
          database.organization,
          database.name,
          branch.name,
        );
        expect(resized.cluster_name).toEqual("PS_20");

        yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("Branch", {
              database,
              parentBranch: "main",
              isProduction: false,
            });

            return { database, branch };
          }),
        );

        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(database.name, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "can create branch with Branch object as parent",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { database, parent, child } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              clusterSize: "PS_10",
            });
            const parent = yield* Planetscale.MySQLBranch("ParentBranch", {
              database,
              parentBranch: "main",
              isProduction: false,
            });
            const child = yield* Planetscale.MySQLBranch("ChildBranch", {
              database,
              parentBranch: parent,
              isProduction: false,
            });

            return { database, parent, child };
          }),
        );

        expect(child).toMatchObject({
          database: database.name,
          parentBranch: parent.name,
          production: false,
        });

        const live = yield* Planetscale.waitForBranchReady(
          database.organization,
          database.name,
          child.name,
        );
        expect(live.parent_branch).toEqual(parent.name);

        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(database.name, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );

  test.provider(
    "branch with RemovalPolicy.retain(true) should not be deleted via API",
    (stack) =>
      Effect.gen(function* () {
        const dbName = "alchemy-branch-retain";
        const branchName = "retained";

        yield* stack.destroy();

        const { database } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            }).pipe(RemovalPolicy.retain(true));

            return { database };
          }),
        );

        yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          "main",
        );
        yield* deleteBranchIfExists(database.organization, dbName, branchName);

        const { branch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            }).pipe(RemovalPolicy.retain(true));
            const branch = yield* Planetscale.MySQLBranch("RetainedBranch", {
              name: branchName,
              database,
              parentBranch: "main",
              isProduction: false,
            }).pipe(RemovalPolicy.retain(true));

            return { database, branch };
          }),
        );

        expect(branch.name).toEqual(branchName);

        yield* stack.destroy();

        const live = yield* Planetscale.waitForBranchReady(
          database.organization,
          dbName,
          branchName,
        );
        expect(live.name).toEqual(branchName);

        yield* deleteBranchIfExists(database.organization, dbName, branchName);
        yield* ops
          .deleteDatabase({
            organization: database.organization,
            database: dbName,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitForDatabaseToBeDeleted(dbName, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );
});

const deleteBranchIfExists = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
) {
  yield* ops
    .deleteBranch({ organization, database, branch })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
  yield* waitForBranchToBeDeleted(organization, database, branch);
});

const waitForBranchToBeDeleted = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
) {
  yield* ops.getBranch({ organization, database, branch }).pipe(
    Effect.flatMap(() => Effect.fail(new BranchStillExists())),
    Effect.retry({
      while: (e): e is BranchStillExists => e instanceof BranchStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
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

const waitForBackupSuccess = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
  id: string,
) {
  return yield* ops.getBackup({ organization, database, branch, id }).pipe(
    Effect.flatMap((backup) => {
      switch (backup.state) {
        case "success":
          return Effect.succeed(backup);
        case "failed":
        case "canceled":
        case "ignored":
          return Effect.fail(
            new BackupNotReady({ retryable: false, state: backup.state }),
          );
        default:
          return Effect.fail(
            new BackupNotReady({ retryable: true, state: backup.state }),
          );
      }
    }),
    Effect.retry({
      while: (e): e is BackupNotReady =>
        e instanceof BackupNotReady && e.retryable,
      schedule: Schedule.max([
        Schedule.exponential(1_000),
        Schedule.recurs(120),
      ]),
    }),
  );
});

class BranchStillExists extends Data.TaggedError("BranchStillExists") {}

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}

class BackupNotReady extends Data.TaggedError("BackupNotReady")<{
  retryable: boolean;
  state: string;
}> {}
