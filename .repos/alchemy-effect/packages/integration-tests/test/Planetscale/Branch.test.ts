import * as Planetscale from "@alchemy.run/planetscale";
import { hashMigrations } from "@alchemy.run/sql/SqlFile";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ps from "@distilled.cloud/planetscale";
import { adopt } from "alchemy/AdoptPolicy";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import { Data, Schedule } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Planetscale.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixturesDir = `${import.meta.dirname}/Postgres/fixtures`;

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

test.provider(
  "diff tracks Postgres branch replica intent",
  () =>
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
      // Converged: a noop that still carries the `name` stable for `--force`.
      expect(alreadyConvergedToNonHa).toEqual({
        action: "noop",
        stables: ["organization", "database", "name"],
      });

      const exactHaCountChanged = yield* provider.diff!({
        id: "Branch",
        fqn: "Branch",
        instanceId: "instance",
        olds: props(2),
        news: props(3),
        oldBindings: [],
        newBindings: [],
        output: branchOutput({ desiredReplicas: 2, hasReplicas: true, hasReadOnlyReplicas: false }),
      });
      // A non-renaming update advertises `name` as stable so downstream
      // consumers keep resolving `branch.name` at plan time.
      expect(exactHaCountChanged).toEqual({
        action: "update",
        stables: ["organization", "database", "name"],
      });
    }),
  { tags: ["provider:planetscale", "provider:planetscale:postgres", "live"] },
);

describe.skipIf(!process.env.PLANETSCALE_TEST)(
  "Branch",
  { tags: ["provider:planetscale", "live"] },
  () => {
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

            const live = yield* ps.getBranch({
              organization,
              database: dbName,
              branch: branchName,
            });

            expect(live.has_replicas).toBe(false);
            expect(live.has_read_only_replicas).toBe(false);

            const plan = yield* stack.plan(program);
            expect(plan.resources.ReplicaBranch).toMatchObject({ action: "noop" });

            yield* stack.destroy();
            yield* waitForBranchToBeDeleted(dbName, branchName, organization);
          }).pipe(Effect.ensuring(deleteBranchIfExists(dbName, branchName, organization)));
        }).pipe(logLevel),
      { timeout: 5_000_000, tags: ["provider:planetscale:postgres"] },
    );

    test.provider(
      "Postgres branch off an ARM parent expands a short cluster size to an ARM SKU",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, branch } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("ArmParentDatabase", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const branch = yield* Planetscale.PostgresBranch("ArmChildBranch", {
                database,
                parentBranch: "main",
                clusterSize: "PS_DEV",
              });

              return { database, branch };
            }),
          );

          const live = yield* ps.getBranch({
            organization: database.organization,
            database: database.name,
            branch: branch.name,
          });

          expect(live.cluster_architecture).toEqual("aarch64");
          expect(live.cluster_name).toEqual("PS_DEV_AWS_ARM");

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(database.name, database.organization);
        }).pipe(logLevel),
      { timeout: 5_000_000, tags: ["provider:planetscale:postgres"] },
    );

    // Regression for #1955: a PostgresBranch adopting the database's default
    // `main` branch (with a role on it, as in the issue) must report no drift
    // right after a successful deploy.
    test.provider(
      "Postgres default branch reports no drift after deploy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, branch } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("DriftDatabase", {
                clusterSize: "PS_10",
              });
              const branch = yield* Planetscale.PostgresBranch("Branch", {
                database,
                name: "main",
                migrations: `${fixturesDir}/migrations`,
              }).pipe(adopt(true));
              yield* Planetscale.PostgresRole("Role", {
                database,
                branch,
                inheritedRoles: [],
              });

              return { database, branch };
            }),
          );

          expect(branch.name).toEqual("main");
          expect(branch.migrationsHashes["0001_create_widgets.sql"]).toEqual(expect.any(String));

          // PlanetScale bumps the branch's `updated_at` a few seconds after the
          // deploy (no config change). Wait for that bump so drift detection
          // observes the volatile timestamp.
          yield* ps
            .getBranch({
              organization: branch.organization,
              database: branch.database,
              branch: branch.name,
            })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (live) => live.updated_at !== branch.updatedAt,
                times: 20,
              }),
            );

          const { plan } = yield* Drift.plan({ name: stack.name, stage: stack.stage }).pipe(
            Effect.provide(stack.state),
          );
          const { action, drift } = plan.resources.Branch!;
          expect({ action, drift }).toEqual({ action: "noop", drift: undefined });
          expect(plan.resources.DriftDatabase).toMatchObject({ action: "noop" });

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(database.name, database.organization);
        }).pipe(logLevel),
      { timeout: 5_000_000, tags: ["provider:planetscale:postgres"] },
    );

    // #1389: an edited already-applied migration used to plan as an
    // in-place update; the runner skipped it by name and persisted the new
    // hash, silently accepting rewritten history.
    test.provider(
      "rewritten migration history replaces a development branch and fails on production",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = path.join(import.meta.dirname, "../../.tmp", `ps-rewrite-${stack.stage}`);
          const databaseDir = path.join(root, "database");
          const branchDir = path.join(root, "branch");
          yield* fs.remove(root, { recursive: true, force: true });
          yield* fs.makeDirectory(databaseDir, { recursive: true });
          yield* fs.makeDirectory(branchDir, { recursive: true });
          const init = "CREATE TABLE users (id int);";
          yield* fs.writeFileString(path.join(databaseDir, "0001_init.sql"), init);
          yield* fs.writeFileString(path.join(branchDir, "0001_init.sql"), init);
          // Applied only on the development branch, never on main.
          yield* fs.writeFileString(
            path.join(branchDir, "0002_posts.sql"),
            "CREATE TABLE posts (id int);",
          );

          const program = Effect.gen(function* () {
            const database = yield* Planetscale.PostgresDatabase("RewriteDatabase", {
              clusterSize: "PS_5",
              migrations: databaseDir,
            });
            const branch = yield* Planetscale.PostgresBranch("RewriteBranch", {
              database,
              parentBranch: "main",
              migrations: branchDir,
            });
            return { database, branch };
          });

          yield* stack.destroy();

          const first = yield* stack.deploy(program);
          expect(first.branch.production).toBe(false);

          // Rewrite the branch-only migration: the branch re-forks from main
          // (which never ran it) and applies the new version.
          yield* fs.writeFileString(
            path.join(branchDir, "0002_posts.sql"),
            "CREATE TABLE posts (id int, title text);",
          );
          const plan = yield* stack.plan(program);
          expect(plan.resources.RewriteBranch).toMatchObject({ action: "replace" });

          const second = yield* stack.deploy(program);
          expect(second.branch.name).not.toEqual(first.branch.name);
          expect(second.branch.migrationsHashes).toEqual(yield* hashMigrations(branchDir));
          yield* waitForBranchToBeDeleted(
            first.database.name,
            first.branch.name,
            first.database.organization,
          );

          // Rewrite a migration main (a production branch) already ran: no
          // replacement is possible, so the deploy fails and keeps the
          // recorded history.
          yield* fs.writeFileString(
            path.join(databaseDir, "0001_init.sql"),
            "CREATE TABLE users (id int, name text);",
          );
          const rewrite = yield* Effect.exit(stack.deploy(program));
          expect(Exit.isFailure(rewrite)).toBe(true);
          if (Exit.isFailure(rewrite)) {
            expect(Cause.pretty(rewrite.cause)).toContain("forward migration");
          }

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(first.database.name, first.database.organization);
        }).pipe(logLevel),
      { timeout: 5_000_000, tags: ["provider:planetscale:postgres"] },
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
          expect(all.every((b) => b.organization === database.organization)).toBe(true);

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(dbName, database.organization);
        }).pipe(logLevel),
      { timeout: 5_000_000, tags: ["provider:planetscale:mysql"] },
    );
  },
);

const waitForDatabaseToBeDeleted = Effect.fn(function* (database: string, organization: string) {
  yield* ps.getDatabase({ organization, database }).pipe(
    Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
    Effect.retry({
      while: (e): e is DatabaseStillExists => e instanceof DatabaseStillExists,
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
  yield* ps.getBranch({ organization, database, branch }).pipe(
    Effect.flatMap(() => Effect.fail(new BranchStillExists())),
    Effect.retry({
      while: (e): e is BranchStillExists => e instanceof BranchStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );
});

const deleteBranchIfExists = (database: string, branch: string, organization: string) =>
  ps.deleteBranch({ organization, database, branch }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.flatMap(() => waitForBranchToBeDeleted(database, branch, organization)),
    Effect.ignore,
  );

class BranchStillExists extends Data.TaggedError("BranchStillExists") {}
class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
