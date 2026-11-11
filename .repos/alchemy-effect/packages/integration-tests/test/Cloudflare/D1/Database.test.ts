import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { hashMigrations } from "@alchemy.run/sql/SqlFile";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Drift from "alchemy/Drift";
import { State } from "alchemy/State";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "create and delete database with default props",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("DefaultDatabase");
        }),
      );

      expect(database.databaseName).toBeDefined();
      expect(database.databaseId).toBeDefined();

      const actualDatabase = yield* d1.getDatabase({ accountId, databaseId: database.databaseId });
      expect(actualDatabase.uuid).toEqual(database.databaseId);

      // Cloudflare reports `{ mode: "disabled" }` for an omitted
      // `readReplication`; `read` keeps the persisted shape, so an unchanged
      // database is not reported as drifted.
      const detectDrift = () => Drift.detect(stack).pipe(Effect.provide(stack.state));
      const unchanged = yield* detectDrift();
      expect(unchanged.resources.DefaultDatabase?.action).toBe("unchanged");

      // Enabling replication outside Alchemy is still real drift.
      yield* d1.patchDatabase({
        accountId,
        databaseId: database.databaseId,
        readReplication: { mode: "auto" },
      });
      const changed = yield* detectDrift();
      expect(changed.resources.DefaultDatabase?.action).toBe("drifted");
      expect(changed.resources.DefaultDatabase?.attr.readReplication).toEqual({ mode: "auto" });

      yield* stack.destroy();

      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "create, update, delete database",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("TestDatabase", {
            readReplication: { mode: "disabled" },
          });
        }),
      );

      const actualDatabase = yield* d1.getDatabase({ accountId, databaseId: database.databaseId });
      expect(actualDatabase.uuid).toEqual(database.databaseId);

      const updatedDatabase = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("TestDatabase", {
            readReplication: { mode: "auto" },
          });
        }),
      );

      expect(updatedDatabase.databaseId).toEqual(database.databaseId);

      const actualUpdatedDatabase = yield* d1.getDatabase({
        accountId,
        databaseId: updatedDatabase.databaseId,
      });
      expect(actualUpdatedDatabase.readReplication?.mode).toEqual("auto");

      yield* stack.destroy();

      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "replace keeping an explicit name deletes the old database first and rebinds its Worker",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const path = yield* Path.Path;
      const main = path.join(import.meta.dirname, "fixtures", "replace-worker.ts");

      // The database is bound to a Worker so the replacement is exercised
      // with a live dependent: the old database is deleted while the Worker
      // still binds it, and the Worker must then be re-bound to the new one.
      const deployWithWorker = (props: Cloudflare.D1.DatabaseProps) =>
        stack.deploy(
          Effect.gen(function* () {
            const database = yield* Cloudflare.D1.Database("ReplacedDatabase", props);
            const worker = yield* Cloudflare.Worker("ReplacedDatabaseWorker", {
              main,
              env: { DB: database },
            });
            return {
              databaseId: database.databaseId,
              databaseName: database.databaseName,
              workerName: worker.workerName,
              url: worker.url.as<string>(),
            };
          }),
        );

      yield* stack.destroy();

      // A generated name keeps concurrent runs collision-free; the replace
      // below pins it as the explicit name.
      const initial = yield* deployWithWorker({});
      yield* writeEntry(initial.url);
      expect(yield* readEntries(initial.url)).toEqual(1);

      // `primaryLocationHint` is fixed at creation, so this is a replace
      // whose replacement has the same name as the database it replaces.
      const replaced = yield* deployWithWorker({
        name: initial.databaseName,
        primaryLocationHint: "weur",
      });

      expect(replaced.databaseName).toEqual(initial.databaseName);
      expect(replaced.databaseId).not.toEqual(initial.databaseId);
      yield* waitForDatabaseToBeDeleted(initial.databaseId, accountId);
      const actualDatabase = yield* d1.getDatabase({
        accountId,
        databaseId: replaced.databaseId,
      });
      expect(actualDatabase.name).toEqual(initial.databaseName);

      // The deployed Worker's D1 binding now points at the replacement.
      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: replaced.workerName,
      });
      const d1Bindings = (settings.bindings ?? []).flatMap((binding) =>
        binding.type === "d1" ? [{ name: binding.name, databaseId: binding.databaseId }] : [],
      );
      expect(d1Bindings).toEqual([{ name: "DB", databaseId: replaced.databaseId }]);

      // The replacement starts empty, and the Worker writes land in it.
      yield* writeEntry(replaced.url);
      expect(yield* readEntries(replaced.url)).toEqual(1);
      expect(
        yield* queryAll<{ n: number }>(
          accountId,
          replaced.databaseId,
          "SELECT count(*) AS n FROM entries;",
        ),
      ).toEqual([{ n: 1 }]);

      yield* stack.destroy();

      yield* waitForDatabaseToBeDeleted(replaced.databaseId, accountId);
      yield* waitForWorkerToBeDeleted(replaced.workerName, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"], timeout: 180_000 },
);

test.provider(
  "applies migrations from migrationsDir",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-migrations-" });

      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      );

      yield* stack.destroy();

      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("MigrationDatabase", { migrations: migrationsDir });
        }),
      );

      expect(database.migrationsDir).toEqual(migrationsDir);
      expect(database.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(database.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);

      const tables = yield* listTables(accountId, database.databaseId);
      expect(tables).toContain("users");
      expect(tables).toContain("posts");
      expect(tables).toContain("__alchemy_migrations");

      // Alchemy's shape: INTEGER ids, name-keyed, hashed.
      const applied = yield* queryAll<{ id: number; name: string; hash: string }>(
        accountId,
        database.databaseId,
        "SELECT id, name, hash FROM __alchemy_migrations ORDER BY id;",
      );
      expect(applied.map((r) => ({ id: r.id, name: r.name }))).toEqual([
        { id: 1, name: "0001_users.sql" },
        { id: 2, name: "0002_posts.sql" },
      ]);
      expect(applied[0].hash).toMatch(/^[0-9a-f]{64}$/);

      // Adding a new migration on update should apply only the new one and the
      // sequential id should continue from where it left off.
      yield* fs.writeFileString(
        path.join(migrationsDir, "0003_comments.sql"),
        "CREATE TABLE comments (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("MigrationDatabase", { migrations: migrationsDir });
        }),
      );
      expect(updated.databaseId).toEqual(database.databaseId);

      const tablesAfter = yield* listTables(accountId, database.databaseId);
      expect(tablesAfter).toContain("comments");

      const appliedAfter = yield* queryAll<{ id: number; name: string }>(
        accountId,
        database.databaseId,
        "SELECT id, name FROM __alchemy_migrations ORDER BY id;",
      );
      expect(appliedAfter).toEqual([
        { id: 1, name: "0001_users.sql" },
        { id: 2, name: "0002_posts.sql" },
        { id: 3, name: "0003_comments.sql" },
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "applies migrations using a custom migrationsTable",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-custom-migrations-",
      });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_create.sql"),
        "CREATE TABLE test_migrations_table (id INTEGER PRIMARY KEY, name TEXT);",
      );

      yield* stack.destroy();

      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("CustomMigrationsTableDb", {
            migrations: { dir: migrationsDir, table: "custom_migration_tracking" },
          });
        }),
      );

      expect(database.migrationsTable).toEqual("custom_migration_tracking");

      const tables = yield* listTables(accountId, database.databaseId);
      expect(tables).toContain("custom_migration_tracking");
      expect(tables).toContain("test_migrations_table");
      // The default table must NOT be created when a custom one is configured.
      expect(tables).not.toContain("__alchemy_migrations");

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

/**
 * D1 can run a migration batch and still fail its reply (#1889), or fail a
 * request it never ran. A blind resend of the first would run its DDL twice
 * and fail with "table already exists". The deploy instead reads
 * `__alchemy_migrations`: a batch that landed is done, and one that did not
 * is resent once.
 */
class FlakyD1 extends Context.Service<FlakyD1, { sends: Ref.Ref<Record<string, number>> }>()(
  "test/D1/FlakyD1",
) {}

// Forward every request to Cloudflare, except the first batch that creates
// one of these tables: `lost_reply_notes` runs on D1 and its reply becomes a
// 503; `dropped_request_notes` gets a 503 without reaching D1.
const FlakyD1HttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const { sends } = yield* FlakyD1;
    const unavailable = (request: HttpClientRequest.HttpClientRequest) =>
      HttpClientResponse.fromWeb(request, new Response("Service Unavailable", { status: 503 }));
    return HttpClient.transform(client, (response, request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const table = request.url.endsWith("/query")
          ? ["lost_reply_notes", "dropped_request_notes"].find((name) =>
              body.includes(`CREATE TABLE ${name}`),
            )
          : undefined;
        if (table === undefined) return yield* response;
        const counts = yield* Ref.updateAndGet(sends, (counts) => ({
          ...counts,
          [table]: (counts[table] ?? 0) + 1,
        }));
        if (counts[table] !== 1) return yield* response;
        if (table === "lost_reply_notes") yield* response;
        return unavailable(request);
      }),
    );
  }),
);

const flaky = Test.make({
  providers: Cloudflare.providers().pipe(
    Layer.provide(FlakyD1HttpClient),
    Layer.provideMerge(
      Layer.effect(
        FlakyD1,
        Effect.map(Ref.make<Record<string, number>>({}), (sends) => ({ sends })),
      ),
    ),
  ),
});

// D1 ran the batch, so its bookkeeping row is there and the deploy succeeds
// without sending it again.
flaky.test.provider(
  "a migration batch whose reply is lost is not resent",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { sends } = yield* FlakyD1;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-lost_reply_notes-" });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_notes.sql"),
        "CREATE TABLE lost_reply_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
      );
      const program = Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("LostReplyDb", { migrations: migrationsDir });
      });

      yield* stack.destroy();
      // A retried attempt starts over, so its first batch is faulted again.
      yield* Ref.update(sends, (counts) => ({ ...counts, lost_reply_notes: 0 }));

      const database = yield* stack.deploy(program);
      expect((yield* Ref.get(sends))["lost_reply_notes"]).toEqual(1);
      expect(yield* listTables(accountId, database.databaseId)).toContain("lost_reply_notes");
      const applied = yield* queryAll<{ name: string }>(
        accountId,
        database.databaseId,
        "SELECT name FROM __alchemy_migrations ORDER BY id;",
      );
      expect(applied.map((row) => row.name)).toEqual(["0001_notes.sql"]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"], timeout: 180_000 },
);

// D1 never ran the batch, so `__alchemy_migrations` has no row for it and the
// deploy sends it once more.
flaky.test.provider(
  "a migration batch that never reached D1 is resent once",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { sends } = yield* FlakyD1;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-dropped_request_notes-",
      });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_notes.sql"),
        "CREATE TABLE dropped_request_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
      );
      const program = Effect.gen(function* () {
        return yield* Cloudflare.D1.Database("DroppedRequestDb", { migrations: migrationsDir });
      });

      yield* stack.destroy();
      // A retried attempt starts over, so its first batch is faulted again.
      yield* Ref.update(sends, (counts) => ({ ...counts, dropped_request_notes: 0 }));

      const database = yield* stack.deploy(program);
      expect((yield* Ref.get(sends))["dropped_request_notes"]).toEqual(2);
      expect(yield* listTables(accountId, database.databaseId)).toContain("dropped_request_notes");
      const applied = yield* queryAll<{ name: string }>(
        accountId,
        database.databaseId,
        "SELECT name FROM __alchemy_migrations ORDER BY id;",
      );
      expect(applied.map((row) => row.name)).toEqual(["0001_notes.sql"]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"], timeout: 180_000 },
);

/**
 * Adopting a drizzle-kit-migrated database: the user ran `drizzle-kit
 * migrate` before Alchemy ever saw the database, leaving history in
 * `__drizzle_migrations`. First deploy performs the one-way conversion —
 * history copies into `__alchemy_migrations` (validated against local
 * files, hashes carried verbatim) and drizzle's table is frozen, never
 * written or dropped.
 */
test.provider(
  "adopts a drizzle-kit-migrated database via one-way conversion",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-drizzle-" });
      const initSql =
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);\n--> statement-breakpoint\nCREATE UNIQUE INDEX users_name_unique ON users (name);";
      yield* fs.makeDirectory(path.join(migrationsDir, "20240101000000_init"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101000000_init", "migration.sql"),
        initSql,
      );
      const [initRecord] = yield* hashMigrations(migrationsDir).pipe(
        Effect.map((hashes) => Object.values(hashes)),
      );

      yield* stack.destroy();

      // Phase 1: what `drizzle-kit migrate` left behind — deploy without
      // migrations, then hand-write drizzle's table + the applied schema.
      const seeded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("DrizzleAdoptionDb");
        }),
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        "CREATE UNIQUE INDEX users_name_unique ON users (name);",
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        `CREATE TABLE __drizzle_migrations (
           id INTEGER PRIMARY KEY,
           hash text NOT NULL,
           created_at numeric,
           name text,
           applied_at TEXT
         );`,
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        `INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES
           ('${initRecord}', 1704067200000, '20240101000000_init', '2024-01-01T00:00:00.000Z');`,
      );

      // Phase 2: first Alchemy deploy with migrations + a new pending one.
      yield* fs.makeDirectory(path.join(migrationsDir, "20240102000000_posts"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240102000000_posts", "migration.sql"),
        "CREATE TABLE posts (id integer PRIMARY KEY NOT NULL, title text NOT NULL);",
      );
      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("DrizzleAdoptionDb", { migrations: migrationsDir });
        }),
      );
      expect(database.databaseId).toEqual(seeded.databaseId);
      expect(database.migrationsTable).toEqual("__alchemy_migrations");

      // History converted (hash carried verbatim), only the pending
      // migration ran (a replay of init's bare CREATE TABLE would fail).
      const applied = yield* queryAll<{ name: string; hash: string }>(
        accountId,
        database.databaseId,
        "SELECT name, hash FROM __alchemy_migrations ORDER BY id;",
      );
      expect(applied.map((r) => r.name)).toEqual(["20240101000000_init", "20240102000000_posts"]);
      expect(applied[0].hash).toBe(initRecord);
      const tables = yield* listTables(accountId, database.databaseId);
      expect(tables).toContain("posts");

      // One-way: drizzle's table is frozen, not dropped, not extended.
      const frozen = yield* queryAll<{ name: string }>(
        accountId,
        database.databaseId,
        "SELECT name FROM __drizzle_migrations ORDER BY id;",
      );
      expect(frozen.map((r) => r.name)).toEqual(["20240101000000_init"]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

/**
 * Adopting a wrangler-migrated database: `wrangler d1 migrations apply`
 * left its real table behind; the first Alchemy deploy converts that
 * history into `__alchemy_migrations` (hashes backfilled from local
 * files) and freezes wrangler's table.
 */
test.provider(
  "adopts a wrangler-migrated database via one-way conversion",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-wrangler-" });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      );

      yield* stack.destroy();

      // Phase 1: what `wrangler d1 migrations apply` left behind.
      const seeded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("WranglerAdoptionDb");
        }),
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        `CREATE TABLE d1_migrations(
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           name       TEXT UNIQUE,
           applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
         );`,
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        "INSERT INTO d1_migrations (name) VALUES ('0001_users.sql');",
      );

      // Phase 2: first Alchemy deploy — converts, applies only 0002.
      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("WranglerAdoptionDb", { migrations: migrationsDir });
        }),
      );
      expect(database.databaseId).toEqual(seeded.databaseId);
      expect(database.migrationsTable).toEqual("__alchemy_migrations");

      const applied = yield* queryAll<{ name: string; hash: string }>(
        accountId,
        database.databaseId,
        "SELECT name, hash FROM __alchemy_migrations ORDER BY id;",
      );
      expect(applied.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
      expect(applied[0].hash).toMatch(/^[0-9a-f]{64}$/);
      const tables = yield* listTables(accountId, database.databaseId);
      expect(tables).toContain("posts");

      // wrangler's table is frozen.
      const frozen = yield* queryAll<{ name: string }>(
        accountId,
        database.databaseId,
        "SELECT name FROM d1_migrations ORDER BY id;",
      );
      expect(frozen.map((r) => r.name)).toEqual(["0001_users.sql"]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

/**
 * True roll-forward: state row AND physical table are rewritten to exactly
 * what pre-registry Alchemy persisted (3-column `id TEXT PK` table,
 * `migrationsHashes` + `migrationsTable` in state), then a normal deploy
 * runs on top. The persisted table name keeps winning (legacy deploys stay
 * on `d1_migrations`), the table upgrades in place to Alchemy's shape, and
 * nothing replays (0001/0002's bare CREATE TABLEs would fail).
 */
test.provider(
  "rolls forward from pre-registry state and 3-column table without replaying",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-rollforward-" });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      );

      yield* stack.destroy();

      // Phase 1: deploy so the database, tables, and state exist.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDb", { migrations: migrationsDir });
        }),
      );

      // Phase 2: rewrite BOTH artifacts to the pre-registry shape.
      // 2a. The physical table: drop the modern one, recreate the old
      // 3-column `id TEXT PK` shape under the old default name.
      yield* execSql(accountId, deployed.databaseId, "DROP TABLE __alchemy_migrations;");
      yield* execSql(
        accountId,
        deployed.databaseId,
        `CREATE TABLE d1_migrations (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );`,
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        `INSERT INTO d1_migrations (id, name, applied_at) VALUES
           ('00001', '0001_users.sql', '2024-01-01 00:00:00'),
           ('00002', '0002_posts.sql', '2024-01-01 00:01:00');`,
      );
      // 2b. The state row: exactly what old code persisted — table name
      // pinned to d1_migrations (the old D1 default).
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const row = yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn: "RollForwardDb",
        });
        const attr = { ...(row as any).attr, migrationsTable: "d1_migrations" };
        yield* state.set({
          stack: stack.name,
          stage: stack.stage,
          fqn: "RollForwardDb",
          value: { ...(row as any), attr },
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: add a migration and redeploy on top of the legacy state.
      yield* fs.writeFileString(
        path.join(migrationsDir, "0003_comments.sql"),
        "CREATE TABLE comments (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
      );
      const rolled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDb", { migrations: migrationsDir });
        }),
      );
      expect(rolled.databaseId).toEqual(deployed.databaseId);
      // The persisted table name keeps winning for legacy deploys.
      expect(rolled.migrationsTable).toEqual("d1_migrations");

      const columns = yield* queryAll<{ name: string; type: string }>(
        accountId,
        deployed.databaseId,
        "PRAGMA table_info(d1_migrations);",
      );
      // Upgraded in place to Alchemy's shape.
      expect(columns.map((c) => c.name)).toEqual([
        "id",
        "hash",
        "created_at",
        "name",
        "applied_at",
      ]);
      expect(columns.find((c) => c.name === "id")?.type).toBe("INTEGER");
      const rows = yield* queryAll<{ id: number; name: string }>(
        accountId,
        deployed.databaseId,
        "SELECT id, name FROM d1_migrations ORDER BY id;",
      );
      expect(rows).toEqual([
        { id: 1, name: "0001_users.sql" },
        { id: 2, name: "0002_posts.sql" },
        { id: 3, name: "0003_comments.sql" },
      ]);
      const tables = yield* listTables(accountId, deployed.databaseId);
      expect(tables).toContain("comments");

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(deployed.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

/**
 * The Seth-shaped roll-forward: a drizzle-LAYOUT directory whose history
 * was applied by pre-registry Alchemy under flat keys
 * (`<dir>/migration.sql`) in the legacy table. The persisted table name
 * must keep winning — starting a second bookkeeping table would replay
 * history into a live database.
 */
test.provider(
  "rolls forward legacy state over a drizzle-layout dir without switching tables",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-rollforward-drizzle-",
      });
      yield* fs.makeDirectory(path.join(migrationsDir, "20240101000000_init"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101000000_init", "migration.sql"),
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
      );

      yield* stack.destroy();

      // Phase 1: deploy WITHOUT migrations, then hand-write what old
      // Alchemy left behind: migration 1 really ran, recorded under its
      // flat path key in the legacy 3-column table.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDrizzleDb");
        }),
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        `CREATE TABLE d1_migrations (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at TEXT NOT NULL
         );`,
      );
      yield* execSql(
        accountId,
        deployed.databaseId,
        `INSERT INTO d1_migrations (id, name, applied_at) VALUES
           ('00001', '20240101000000_init/migration.sql', '2024-01-01 00:00:00');`,
      );
      // Old-style state: dir + table + hashes, no format stamp.
      const legacyHashes = yield* hashMigrations(migrationsDir);
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const row = yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn: "RollForwardDrizzleDb",
        });
        const attr = {
          ...(row as any).attr,
          migrationsDir,
          migrationsTable: "d1_migrations",
          migrationsHashes: legacyHashes,
        };
        yield* state.set({
          stack: stack.name,
          stage: stack.stage,
          fqn: "RollForwardDrizzleDb",
          value: { ...(row as any), attr },
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 2: add a second drizzle-layout migration and redeploy WITH
      // migrations configured.
      yield* fs.makeDirectory(path.join(migrationsDir, "20240102000000_posts"));
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240102000000_posts", "migration.sql"),
        "CREATE TABLE posts (id integer PRIMARY KEY NOT NULL, title text NOT NULL);",
      );
      const rolled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("RollForwardDrizzleDb", {
            migrations: migrationsDir,
          });
        }),
      );
      expect(rolled.databaseId).toEqual(deployed.databaseId);
      // The persisted table name keeps winning; no second bookkeeping
      // table appears.
      expect(rolled.migrationsTable).toEqual("d1_migrations");

      const tables = yield* listTables(accountId, deployed.databaseId);
      expect(tables).not.toContain("__drizzle_migrations");
      expect(tables).toContain("posts");

      // Migration 1 was not replayed (bare CREATE TABLE would fail);
      // migration 2 was recorded under the same flat-path convention.
      const rows = yield* queryAll<{ name: string }>(
        accountId,
        deployed.databaseId,
        "SELECT name FROM d1_migrations ORDER BY id;",
      );
      expect(rows.map((r) => r.name)).toEqual([
        // The legacy row keeps its flat key; new records use the current
        // directory-name convention. Aliasing keeps both recognized.
        "20240101000000_init/migration.sql",
        "20240102000000_posts",
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(deployed.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

/**
 * State-lost adoption of the OLDEST pre-registry deploys: a 2-column
 * `d1_migrations` exists but state carries no table name. The legacy table
 * is treated as a conversion source — history copies into
 * `__alchemy_migrations` and the old table is frozen, exactly like a
 * foreign tool's table.
 */
test.provider(
  "converts a legacy 2-column d1_migrations table into __alchemy_migrations",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-legacy-" });
      // History validation is strict (drizzle's own upgrade policy): every
      // recorded row must match a local file, so the two "previously
      // applied" migrations exist in the dir. Their bare CREATE TABLEs
      // would fail if replayed, which is exactly what the upgrade must not
      // do.
      yield* fs.writeFileString(
        path.join(migrationsDir, "0000_initial_setup.sql"),
        "CREATE TABLE settings (id INTEGER PRIMARY KEY, value TEXT);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_add_indexes.sql"),
        "CREATE INDEX settings_value_idx ON settings (value);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_create_users.sql"),
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      );
      yield* fs.writeFileString(
        path.join(migrationsDir, "0003_create_posts.sql"),
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      );

      yield* stack.destroy();

      // Step 1: deploy the database without migrations so we can seed a legacy
      // 2-column d1_migrations table on it before re-deploying with a
      // migrationsDir.
      const seeded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("LegacyMigrationDb");
        }),
      );

      yield* execSql(
        accountId,
        seeded.databaseId,
        `CREATE TABLE d1_migrations (
         id TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       );`,
      );
      yield* execSql(
        accountId,
        seeded.databaseId,
        `INSERT INTO d1_migrations (id, applied_at) VALUES
         ('0000_initial_setup.sql', datetime('now', '-1 day')),
         ('0001_add_indexes.sql', datetime('now', '-1 hour'));`,
      );

      // Step 2: deploy again with a migrationsDir. No table name is
      // persisted in state, so the legacy table becomes a conversion
      // source: history copies into __alchemy_migrations, only the two
      // pending migrations run (0000/0001's SQL would fail if replayed
      // out of order against the frozen history's assumptions).
      const upgraded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("LegacyMigrationDb", { migrations: migrationsDir });
        }),
      );
      expect(upgraded.databaseId).toEqual(seeded.databaseId);
      expect(upgraded.migrationsTable).toEqual("__alchemy_migrations");

      const columns = yield* queryAll<{ name: string; type: string }>(
        accountId,
        seeded.databaseId,
        "PRAGMA table_info(__alchemy_migrations);",
      );
      expect(columns.map((c) => c.name)).toEqual([
        "id",
        "hash",
        "created_at",
        "name",
        "applied_at",
      ]);

      const records = yield* queryAll<{ id: number; name: string }>(
        accountId,
        seeded.databaseId,
        "SELECT id, name FROM __alchemy_migrations ORDER BY id;",
      );
      expect(records.map((r) => r.name)).toEqual([
        "0000_initial_setup.sql",
        "0001_add_indexes.sql",
        "0002_create_users.sql",
        "0003_create_posts.sql",
      ]);
      // Ids are sequential ordinals preserving apply order.
      expect(records.map((r) => r.id)).toEqual(records.map((_, i) => i + 1));

      // The legacy table is frozen, never dropped or rewritten.
      const frozen = yield* queryAll<{ id: string }>(
        accountId,
        seeded.databaseId,
        "SELECT id FROM d1_migrations ORDER BY id;",
      );
      expect(frozen.map((r) => r.id)).toEqual(["0000_initial_setup.sql", "0001_add_indexes.sql"]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(seeded.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "imports SQL files via importFiles",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-imports-" });
      const importPath = path.join(dir, "seed.sql");

      yield* fs.writeFileString(
        importPath,
        [
          "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
          "INSERT INTO widgets (id, label) VALUES (1, 'one');",
          "INSERT INTO widgets (id, label) VALUES (2, 'two');",
        ].join("\n"),
      );

      yield* stack.destroy();

      const database = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("ImportDatabase", { importFiles: [importPath] });
        }),
      );

      expect(database.importHashes[importPath]).toBeDefined();

      const widgets = yield* getResults<{ id: number; label: string }>(
        accountId,
        database.databaseId,
        "SELECT id, label FROM widgets ORDER BY id;",
      );
      expect(widgets).toEqual([
        { id: 1, label: "one" },
        { id: 2, label: "two" },
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "re-imports SQL that D1 already holds after a seed rollback",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-reimport-" });
      const seedPath = path.join(dir, "seed.sql");
      const seed = (mode: string) =>
        fs.writeFileString(
          seedPath,
          [
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            `INSERT OR REPLACE INTO settings (key, value) VALUES ('mode', '${mode}');`,
          ].join("\n"),
        );
      const deploy = stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("ReimportDatabase", { importFiles: [seedPath] });
        }),
      );
      const mode = (databaseId: string) =>
        queryAll<{ value: string }>(
          accountId,
          databaseId,
          "SELECT value FROM settings WHERE key = 'mode';",
        );

      yield* stack.destroy();

      yield* seed("v1");
      const v1 = yield* deploy;
      expect(yield* mode(v1.databaseId)).toEqual([{ value: "v1" }]);

      yield* seed("v2");
      const v2 = yield* deploy;
      expect(v2.databaseId).toEqual(v1.databaseId);
      expect(yield* mode(v2.databaseId)).toEqual([{ value: "v2" }]);

      // Rolling back re-imports SQL whose etag D1 already holds: `init`
      // returns no upload URL and the import has already completed.
      yield* seed("v1");
      const rolledBack = yield* deploy;
      expect(rolledBack.databaseId).toEqual(v1.databaseId);
      expect(rolledBack.importHashes[seedPath]).toEqual(v1.importHashes[seedPath]);
      expect(yield* mode(rolledBack.databaseId)).toEqual([{ value: "v1" }]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(v1.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "clones a database by databaseId",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-clone-id-" });
      const seedPath = path.join(dir, "seed.sql");

      yield* fs.writeFileString(
        seedPath,
        [
          "CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
          "INSERT INTO colors (id, name) VALUES (1, 'red'), (2, 'green'), (3, 'blue');",
        ].join("\n"),
      );

      yield* stack.destroy();

      const { source, target } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Cloudflare.D1.Database("CloneByIdSource", {
            importFiles: [seedPath],
          });
          const target = yield* Cloudflare.D1.Database("CloneByIdTarget", {
            clone: { databaseId: source.databaseId },
          });
          return { source, target };
        }),
      );

      expect(target.databaseId).not.toEqual(source.databaseId);

      const targetColors = yield* getResults<{ id: number; name: string }>(
        accountId,
        target.databaseId,
        "SELECT id, name FROM colors ORDER BY id;",
      );
      expect(targetColors).toEqual([
        { id: 1, name: "red" },
        { id: 2, name: "green" },
        { id: 3, name: "blue" },
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
      yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "clones a database by name lookup",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-clone-name-" });
      const seedPath = path.join(dir, "seed.sql");

      yield* fs.writeFileString(
        seedPath,
        [
          "CREATE TABLE animals (id INTEGER PRIMARY KEY, kind TEXT NOT NULL);",
          "INSERT INTO animals (id, kind) VALUES (1, 'cat'), (2, 'dog');",
        ].join("\n"),
      );

      yield* stack.destroy();

      const { source, target } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Cloudflare.D1.Database("CloneByNameSource", {
            importFiles: [seedPath],
          });
          const target = yield* Cloudflare.D1.Database("CloneByNameTarget", {
            clone: { name: source.databaseName },
          });
          return { source, target };
        }),
      );

      expect(target.databaseId).not.toEqual(source.databaseId);

      const animals = yield* getResults<{ id: number; kind: string }>(
        accountId,
        target.databaseId,
        "SELECT id, kind FROM animals ORDER BY id;",
      );
      expect(animals).toEqual([
        { id: 1, kind: "cat" },
        { id: 2, kind: "dog" },
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
      yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

test.provider(
  "clones a database by passing the source resource directly",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-d1-clone-direct-" });
      const seedPath = path.join(dir, "seed.sql");

      yield* fs.writeFileString(
        seedPath,
        [
          "CREATE TABLE shapes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
          "INSERT INTO shapes (id, name) VALUES (1, 'square'), (2, 'circle');",
        ].join("\n"),
      );

      yield* stack.destroy();

      const { source, target } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Cloudflare.D1.Database("CloneDirectSource", {
            importFiles: [seedPath],
          });
          const target = yield* Cloudflare.D1.Database("CloneDirectTarget", { clone: source });
          return { source, target };
        }),
      );

      expect(target.databaseId).not.toEqual(source.databaseId);

      const shapes = yield* getResults<{ id: number; name: string }>(
        accountId,
        target.databaseId,
        "SELECT id, name FROM shapes ORDER BY id;",
      );
      expect(shapes).toEqual([
        { id: 1, name: "square" },
        { id: 2, name: "circle" },
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(source.databaseId, accountId);
      yield* waitForDatabaseToBeDeleted(target.databaseId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

const queryAll = Effect.fn(function* <T>(accountId: string, databaseId: string, sql: string) {
  const queryDb = yield* d1.queryDatabase;
  const result = yield* queryDb({ accountId, databaseId, sql });
  return (result.result[0]?.results ?? []) as T[];
});

const execSql = (accountId: string, databaseId: string, sql: string) =>
  queryAll<unknown>(accountId, databaseId, sql);

const listTables = Effect.fn(function* (accountId: string, databaseId: string) {
  const rows = yield* queryAll<{ name: string }>(
    accountId,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type='table';",
  );
  return rows.map((r) => r.name);
});

/**
 * D1 query results are eventually consistent following an import/clone, so
 * retry until we see at least one row (matches v1's `getResults` helper).
 */
const getResults = Effect.fn(function* <T>(accountId: string, databaseId: string, sql: string) {
  return yield* queryAll<T>(accountId, databaseId, sql).pipe(
    Effect.flatMap((rows) =>
      rows.length > 0 ? Effect.succeed(rows) : Effect.fail(new EmptyResults({ sql })),
    ),
    Effect.retry({
      while: (e) => e instanceof EmptyResults,
      schedule: Schedule.max([Schedule.spaced(Duration.seconds(1)), Schedule.recurs(10)]),
    }),
    Effect.orDie,
  );
});

// Engine-level adoption: D1 databases have no ownership signal (Cloudflare
// doesn't expose tags on D1), so a name match in `read` is treated as silent
// adoption.
test.provider(
  "existing database (matching name) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy normally so a real D1 database exists. No explicit
      // `name` — the engine generates a random-suffixed physical name
      // (collision-free across concurrent runs); the deploy output hands
      // back the real name, which pins the database's identity for the
      // adoption phase below.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("AdoptableDatabase");
        }),
      );
      const databaseName = initial.databaseName;
      const initialId = initial.databaseId;

      // Phase 2: wipe local state — the database stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "AdoptableDatabase" });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which lists databases by name and returns plain
      // attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("AdoptableDatabase", { name: databaseName });
        }),
      );

      // Same physical database — adoption, not re-creation.
      expect(adopted.databaseId).toEqual(initialId);
      expect(adopted.databaseName).toEqual(databaseName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn: "AdoptableDatabase",
        });
      }).pipe(Effect.provide(stack.state));

      expect((persisted as any)?.attr).toMatchObject({ databaseId: initialId, databaseName });

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:d1", "live"] },
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/** POST to the fixture until it answers 200 (rides out workers.dev cold starts). */
const fetchOk = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((res) =>
      res.text.pipe(
        Effect.flatMap((body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new WorkerNotReady({ status: res.status, body })),
        ),
      ),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkerNotReady",
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]),
    }),
  );

const writeEntry = (url: string) => fetchOk(HttpClientRequest.post(`${url}/write`));

const readEntries = (url: string) =>
  fetchOk(HttpClientRequest.get(`${url}/read`)).pipe(
    Effect.map((body) => (JSON.parse(body) as { rows: number }).rows),
  );

const waitForDatabaseToBeDeleted = Effect.fn(function* (databaseId: string, accountId: string) {
  yield* d1.getDatabase({ accountId, databaseId }).pipe(
    Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
    Effect.retry({
      while: (e): e is DatabaseStillExists => e instanceof DatabaseStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("DatabaseNotFound", () => Effect.void),
  );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
class EmptyResults extends Data.TaggedError("EmptyResults")<{ sql: string }> {}
