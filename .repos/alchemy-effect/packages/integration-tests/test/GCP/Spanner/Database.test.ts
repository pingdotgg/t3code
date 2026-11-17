import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (name: string) =>
  spanner.getProjectsInstancesDatabases({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesDatabases on a missing database fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        spanner.getProjectsInstancesDatabases({
          name: `projects/${project}/instances/alchemy-spanner-missing/databases/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* spanner.listProjectsInstances({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect((page.instances ?? []).map((item) => item.name?.split("/").pop())).not.toContain(
        "alchemy-spanner-missing",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, query, and delete a spanner database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-db-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
            extraStatements: ["CREATE TABLE Users (UserId INT64 NOT NULL) PRIMARY KEY (UserId)"],
          });
          return { instance, database };
        }),
      );

      expect(created.database.name).toContain("/databases/");
      expect(created.database.databaseId).toEqual(expect.any(String));
      expect(created.database.instanceId).toEqual(created.instance.instanceId);
      expect(created.database.enableDropProtection).toEqual(false);
      expect(created.database.state).toEqual("READY");

      const fetched = yield* spanner.getProjectsInstancesDatabases({
        name: created.database.name,
      });
      expect(fetched.name).toEqual(created.database.name);
      expect(fetched.enableDropProtection === true).toEqual(false);

      const ddl = yield* spanner.getDdlProjectsInstancesDatabases({
        database: created.database.name,
      });
      expect(ddl.statements?.some((statement) => statement.includes("Users"))).toEqual(true);

      const session = yield* spanner.createProjectsInstancesDatabasesSessions({
        database: created.database.name,
        body: { session: {} },
      });
      const result = yield* spanner
        .executeSqlProjectsInstancesDatabasesSessions({
          session: session.name ?? "",
          body: { sql: "SELECT 1 AS n" },
        })
        .pipe(
          Effect.ensuring(
            session.name
              ? spanner
                  .deleteProjectsInstancesDatabasesSessions({
                    name: session.name,
                  })
                  .pipe(
                    Effect.catchTag("NotFound", () => Effect.void),
                    Effect.ignore,
                  )
              : Effect.void,
          ),
        );
      expect((result.rows ?? []).length).toBeGreaterThan(0);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            instanceId: created.instance.instanceId,
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-db-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
            databaseId: created.database.databaseId,
            extraStatements: ["CREATE TABLE Users (UserId INT64 NOT NULL) PRIMARY KEY (UserId)"],
            enableDropProtection: true,
          });
          return { instance, database };
        }),
      );

      expect(updated.database.name).toEqual(created.database.name);
      expect(updated.database.enableDropProtection).toEqual(true);

      const refetched = yield* spanner.getProjectsInstancesDatabases({
        name: created.database.name,
      });
      expect(refetched.enableDropProtection).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.database.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 180_000 },
);

/** Rows of one query, read out-of-band through a fresh session. */
const querySpanner = (database: string, sql: string) =>
  Effect.acquireUseRelease(
    spanner.createProjectsInstancesDatabasesSessions({ database, body: { session: {} } }),
    (session) =>
      spanner
        .executeSqlProjectsInstancesDatabasesSessions({
          session: session.name ?? "",
          body: { sql },
        })
        .pipe(Effect.map((result) => (result.rows ?? []) as unknown[][])),
    (session) =>
      spanner
        .deleteProjectsInstancesDatabasesSessions({ name: session.name ?? "" })
        .pipe(Effect.ignore),
  );

const migrationsCases = [
  {
    dialect: "GOOGLE_STANDARD_SQL",
    label: "GoogleSQL",
    first: `-- Users and their posts
CREATE TABLE Users (
  UserId INT64 NOT NULL,
  Name STRING(MAX) -- a ';' in a comment
) PRIMARY KEY (UserId);
CREATE TABLE Posts (PostId INT64 NOT NULL, Title STRING(MAX)) PRIMARY KEY (PostId);`,
    // DDL, then trailing DML that commits with the bookkeeping row.
    second: `ALTER TABLE Users ADD COLUMN Email STRING(MAX);
INSERT INTO Users (UserId, Name, Email) VALUES (1, 'it\\'s; me', 'me@example.com');`,
    interleaved: `CREATE TABLE A (Id INT64 NOT NULL) PRIMARY KEY (Id);
INSERT INTO A (Id) VALUES (1);
CREATE TABLE B (Id INT64 NOT NULL) PRIMARY KEY (Id);`,
    // The second statement names a primary key column that doesn't exist.
    broken: `CREATE TABLE C (Id INT64 NOT NULL) PRIMARY KEY (Id);
CREATE TABLE D (Id INT64 NOT NULL) PRIMARY KEY (Missing);`,
    fixed: `CREATE TABLE C (Id INT64 NOT NULL) PRIMARY KEY (Id);
CREATE TABLE D (Id INT64 NOT NULL) PRIMARY KEY (Id);`,
    // UserId 1 already exists.
    duplicate: "INSERT INTO Users (UserId, Name) VALUES (1, 'again')",
    tables:
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '' AND TABLE_NAME IN ('C', 'D') ORDER BY TABLE_NAME",
    applied: "SELECT name FROM alchemy_migrations ORDER BY name",
    seeded: "SELECT Name, Email FROM Users",
  },
  {
    dialect: "POSTGRESQL",
    label: "PostgreSQL",
    first: `CREATE TABLE users (
  user_id bigint NOT NULL PRIMARY KEY,
  name text
);
CREATE TABLE posts (post_id bigint NOT NULL PRIMARY KEY, title text);`,
    second: `ALTER TABLE users ADD COLUMN email text;
INSERT INTO users (user_id, name, email) VALUES (1, 'it''s; me', 'me@example.com');`,
    interleaved: `CREATE TABLE a (id bigint NOT NULL PRIMARY KEY);
INSERT INTO a (id) VALUES (1);
CREATE TABLE b (id bigint NOT NULL PRIMARY KEY);`,
    broken: `CREATE TABLE c (id bigint NOT NULL PRIMARY KEY);
CREATE TABLE d (id bigint NOT NULL, PRIMARY KEY (missing));`,
    fixed: `CREATE TABLE c (id bigint NOT NULL PRIMARY KEY);
CREATE TABLE d (id bigint NOT NULL PRIMARY KEY);`,
    duplicate: "INSERT INTO users (user_id, name) VALUES (1, 'again')",
    tables:
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('c', 'd') ORDER BY table_name",
    applied: "SELECT name FROM alchemy_migrations ORDER BY name",
    seeded: "SELECT name, email FROM users",
  },
] as const;

for (const testCase of migrationsCases) {
  test.provider.skipIf(!!process.env.FAST)(
    `${testCase.label} database applies migrations, then only pending ones`,
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-spanner-migrations-" });
        const add = (name: string, sql: string) => fs.writeFileString(path.join(dir, name), sql);
        yield* add("0001_users.sql", testCase.first);

        const program = Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("Migrations", {
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-migrations",
            defaultBackupScheduleType: "NONE",
          });
          return yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
            databaseDialect: testCase.dialect,
            migrations: dir,
          });
        });

        yield* stack.destroy();

        const created = yield* stack.deploy(program);
        expect(created.migrationsTable).toEqual("alchemy_migrations");
        expect(Object.keys(created.migrationsHashes)).toEqual(["0001_users.sql"]);
        expect(yield* querySpanner(created.name, testCase.applied)).toEqual([["0001_users.sql"]]);

        // Nothing changed: the next deploy has nothing to apply.
        const unchanged = yield* stack.plan(program);
        expect(unchanged.resources.AppDb?.action).toEqual("noop");

        yield* add("0002_email.sql", testCase.second);
        const pending = yield* stack.plan(program);
        expect(pending.resources.AppDb?.action).toEqual("update");

        const updated = yield* stack.deploy(program);
        expect(updated.name).toEqual(created.name);
        expect(Object.keys(updated.migrationsHashes).sort()).toEqual([
          "0001_users.sql",
          "0002_email.sql",
        ]);
        expect(yield* querySpanner(updated.name, testCase.applied)).toEqual([
          ["0001_users.sql"],
          ["0002_email.sql"],
        ]);
        expect(yield* querySpanner(updated.name, testCase.seeded)).toEqual([
          ["it's; me", "me@example.com"],
        ]);

        // DML between DDL statements can't be applied exactly once.
        yield* add("0003_interleaved.sql", testCase.interleaved);
        const error = yield* stack.deploy(program).pipe(Effect.flip);
        expect(String(error)).toContain("runs DML between DDL statements");
        expect(yield* querySpanner(updated.name, testCase.applied)).toEqual([
          ["0001_users.sql"],
          ["0002_email.sql"],
        ]);
        yield* fs.remove(path.join(dir, "0003_interleaved.sql"));

        // A statement fails after an earlier one applied: the deploy fails,
        // the migration stays unrecorded, and redeploying the same file
        // fails on the statement again rather than on a stale operation.
        yield* add("0003_tables.sql", testCase.broken);
        for (let attempt = 0; attempt < 2; attempt++) {
          const failed = yield* stack.deploy(program).pipe(Effect.flip);
          expect(String(failed)).toContain("Spanner DDL");
          expect(String(failed)).not.toContain("already exists");
        }
        expect(yield* querySpanner(updated.name, testCase.applied)).toEqual([
          ["0001_users.sql"],
          ["0002_email.sql"],
        ]);

        // Fixing the statement resumes after the one already applied.
        yield* add("0003_tables.sql", testCase.fixed);
        yield* stack.deploy(program);
        expect(yield* querySpanner(updated.name, testCase.tables)).toEqual([
          [testCase.dialect === "POSTGRESQL" ? "c" : "C"],
          [testCase.dialect === "POSTGRESQL" ? "d" : "D"],
        ]);
        expect(yield* querySpanner(updated.name, testCase.applied)).toEqual([
          ["0001_users.sql"],
          ["0002_email.sql"],
          ["0003_tables.sql"],
        ]);

        // Failing trailing DML records nothing.
        yield* add("0004_duplicate.sql", testCase.duplicate);
        const duplicate = yield* stack.deploy(program).pipe(Effect.flip);
        expect(String(duplicate)).toContain("Spanner DML");
        expect(yield* querySpanner(updated.name, testCase.applied)).toEqual([
          ["0001_users.sql"],
          ["0002_email.sql"],
          ["0003_tables.sql"],
        ]);

        yield* stack.destroy();
        expect(yield* waitUntilGone(created.name)).toEqual("gone");
      }).pipe(logLevel),
    { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 600_000 },
  );
}
