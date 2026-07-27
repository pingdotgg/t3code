import * as Planetscale from "@/Planetscale";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ops from "@distilled.cloud/planetscale/Operations";
import { describe, expect } from "alchemy-test";
import { Data, Schedule } from "effect";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Planetscale.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const branchOutput = (
  overrides: Partial<Planetscale.PostgresBranchAttributes> = {},
): Planetscale.PostgresBranchAttributes => ({
  name: "branch",
  organization: "org",
  database: "database",
  parentBranch: "main",
  production: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  htmlUrl: "https://planetscale.com/org/database/branch/branch",
  region: { slug: "us-east" },
  migrationsDir: undefined,
  migrationsTable: undefined,
  migrationsHashes: {},
  importHashes: {},
  desiredReplicas: undefined,
  hasReplicas: undefined,
  hasReadOnlyReplicas: undefined,
  ...overrides,
});

test.provider("diff tracks Postgres branch replica intent", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Planetscale.PostgresBranch);
    const props = (replicas: number): Planetscale.PostgresBranchProps => ({
      database: "database",
      parentBranch: "main",
      replicas,
    });

    const alreadyConvergedToNonHa = yield* provider.diff!({
      id: "Branch",
      fqn: "Branch",
      instanceId: "instance",
      olds: props(0),
      news: props(0),
      oldBindings: [],
      newBindings: [],
      output: branchOutput({
        desiredReplicas: 0,
        hasReplicas: false,
        hasReadOnlyReplicas: false,
      }),
    });
    expect(alreadyConvergedToNonHa).toBeUndefined();

    const exactHaCountChanged = yield* provider.diff!({
      id: "Branch",
      fqn: "Branch",
      instanceId: "instance",
      olds: props(2),
      news: props(3),
      oldBindings: [],
      newBindings: [],
      output: branchOutput({
        desiredReplicas: 2,
        hasReplicas: true,
        hasReadOnlyReplicas: false,
      }),
    });
    expect(exactHaCountChanged).toEqual({ action: "update" });
  }),
);

describe.skipIf(!process.env.PLANETSCALE_TEST)("Branch", () => {
  test.provider.skipIf(
    !process.env.PLANETSCALE_BRANCH_REPLICA_TEST ||
      !process.env.PLANETSCALE_BRANCH_REPLICA_DATABASE,
  )(
    "Postgres branch persists replica intent and plans no-op once converged",
    (stack) =>
      Effect.gen(function* () {
        const dbName = process.env.PLANETSCALE_BRANCH_REPLICA_DATABASE!;
        const branchName = `replica-target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const { organization } = yield* yield* Planetscale.Credentials;

        yield* Effect.gen(function* () {
          yield* stack.destroy();
          yield* deleteBranchIfExists(dbName, branchName, organization);

          const program = Effect.gen(function* () {
            const branch = yield* Planetscale.PostgresBranch("ReplicaBranch", {
              name: branchName,
              database: dbName,
              parentBranch: "main",
              replicas: 0,
            });

            return { branch };
          });

          const { branch } = yield* stack.deploy(program);

          expect(branch).toMatchObject({
            name: branchName,
            database: dbName,
            desiredReplicas: 0,
            hasReplicas: false,
            hasReadOnlyReplicas: false,
          });

          const live = yield* ops.getBranch({
            organization,
            database: dbName,
            branch: branchName,
          });

          expect(live.has_replicas).toBe(false);
          expect(live.has_read_only_replicas).toBe(false);

          const plan = yield* stack.plan(program);
          expect(plan.resources.ReplicaBranch).toMatchObject({
            action: "noop",
          });

          yield* stack.destroy();
          yield* waitForBranchToBeDeleted(dbName, branchName, organization);
        }).pipe(
          Effect.ensuring(
            deleteBranchIfExists(dbName, branchName, organization),
          ),
        );
      }).pipe(logLevel),
    5_000_000,
  );

  // Canonical `list()` test (PARENT FAN-OUT): branches live under a database
  // within the credentialed organization. `list()` enumerates every database
  // in the org, lists each database's branches, and keeps only the engine's
  // kind (here MySQL). Deploy one branch, then assert it appears in the
  // exhaustively-paginated result.
  test.provider(
    "list enumerates the deployed branch across the org",
    (stack) =>
      Effect.gen(function* () {
        const dbName = "alchemy-branch-list";
        const branchName = "list-target";

        yield* stack.destroy();

        const { database, branch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("ListBranch", {
              name: branchName,
              database,
              parentBranch: "main",
              isProduction: false,
            });

            return { database, branch };
          }),
        );

        const provider = yield* Provider.findProvider(Planetscale.MySQLBranch);
        const all = yield* provider.list();

        const found = all.find(
          (b) =>
            b.organization === database.organization &&
            b.database === dbName &&
            b.name === branch.name,
        );

        expect(found).toBeDefined();
        expect(found).toMatchObject({
          organization: database.organization,
          database: dbName,
          name: branch.name,
          parentBranch: "main",
          production: false,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          htmlUrl: expect.any(String),
          region: { slug: expect.any(String) },
        });

        // Every item is hydrated into the exact `read` Attributes shape — the
        // org's `main` branch is enumerated too, only as MySQL kind.
        expect(all.every((b) => b.organization === database.organization)).toBe(
          true,
        );

        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(dbName, database.organization);
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

const waitForBranchToBeDeleted = Effect.fn(function* (
  database: string,
  branch: string,
  organization: string,
) {
  yield* ops
    .getBranch({
      organization,
      database,
      branch,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BranchStillExists())),
      Effect.retry({
        while: (e): e is BranchStillExists => e instanceof BranchStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

const deleteBranchIfExists = (
  database: string,
  branch: string,
  organization: string,
) =>
  ops.deleteBranch({ organization, database, branch }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.flatMap(() =>
      waitForBranchToBeDeleted(database, branch, organization),
    ),
    Effect.ignore,
  );

class BranchStillExists extends Data.TaggedError("BranchStillExists") {}
class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
