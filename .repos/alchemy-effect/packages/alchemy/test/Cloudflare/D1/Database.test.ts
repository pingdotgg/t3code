import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { hashMigrations } from "@/SQL/SqlFile.ts";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete database with default props", (stack) =>
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

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    yield* stack.destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete database", (stack) =>
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

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
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
);

test.provider("applies migrations from migrationsDir", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-migrations-",
    });

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
        return yield* Cloudflare.D1.Database("MigrationDatabase", {
          migrations: migrationsDir,
        });
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
        return yield* Cloudflare.D1.Database("MigrationDatabase", {
          migrations: migrationsDir,
        });
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
);

test.provider("applies migrations using a custom migrationsTable", (stack) =>
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
          migrations: {
            dir: migrationsDir,
            table: "custom_migration_tracking",
          },
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
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-drizzle-",
      });
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
          return yield* Cloudflare.D1.Database("DrizzleAdoptionDb", {
            migrations: migrationsDir,
          });
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
      expect(applied.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_posts",
      ]);
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
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-wrangler-",
      });
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
          return yield* Cloudflare.D1.Database("WranglerAdoptionDb", {
            migrations: migrationsDir,
          });
        }),
      );
      expect(database.databaseId).toEqual(seeded.databaseId);
      expect(database.migrationsTable).toEqual("__alchemy_migrations");

      const applied = yield* queryAll<{ name: string; hash: string }>(
        accountId,
        database.databaseId,
        "SELECT name, hash FROM __alchemy_migrations ORDER BY id;",
      );
      expect(applied.map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
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
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-rollforward-",
      });
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
          return yield* Cloudflare.D1.Database("RollForwardDb", {
            migrations: migrationsDir,
          });
        }),
      );

      // Phase 2: rewrite BOTH artifacts to the pre-registry shape.
      // 2a. The physical table: drop the modern one, recreate the old
      // 3-column `id TEXT PK` shape under the old default name.
      yield* execSql(
        accountId,
        deployed.databaseId,
        "DROP TABLE __alchemy_migrations;",
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
           ('00001', '0001_users.sql', '2024-01-01 00:00:00'),
           ('00002', '0002_posts.sql', '2024-01-01 00:01:00');`,
      );
      // 2b. The state row: exactly what old code persisted — table name
      // pinned to d1_migrations (the old D1 default).
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const row = yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "RollForwardDb",
        });
        const attr = {
          ...(row as any).attr,
          migrationsTable: "d1_migrations",
        };
        yield* state.set({
          stack: stack.name,
          stage: "test",
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
          return yield* Cloudflare.D1.Database("RollForwardDb", {
            migrations: migrationsDir,
          });
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
          stage: "test",
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
          stage: "test",
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
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-legacy-",
      });
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
          return yield* Cloudflare.D1.Database("LegacyMigrationDb", {
            migrations: migrationsDir,
          });
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
      expect(frozen.map((r) => r.id)).toEqual([
        "0000_initial_setup.sql",
        "0001_add_indexes.sql",
      ]);

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(seeded.databaseId, accountId);
    }).pipe(logLevel),
);

test.provider("imports SQL files via importFiles", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-imports-",
    });
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
        return yield* Cloudflare.D1.Database("ImportDatabase", {
          importFiles: [importPath],
        });
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
);

test.provider("clones a database by databaseId", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-clone-id-",
    });
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
);

test.provider("clones a database by name lookup", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-d1-clone-name-",
    });
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
);

test.provider(
  "clones a database by passing the source resource directly",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-clone-direct-",
      });
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
          const target = yield* Cloudflare.D1.Database("CloneDirectTarget", {
            clone: source,
          });
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
);

const queryAll = Effect.fn(function* <T>(
  accountId: string,
  databaseId: string,
  sql: string,
) {
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
const getResults = Effect.fn(function* <T>(
  accountId: string,
  databaseId: string,
  sql: string,
) {
  return yield* queryAll<T>(accountId, databaseId, sql).pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.succeed(rows)
        : Effect.fail(new EmptyResults({ sql })),
    ),
    Effect.retry({
      while: (e) => e instanceof EmptyResults,
      schedule: Schedule.max([
        Schedule.spaced(Duration.seconds(1)),
        Schedule.recurs(10),
      ]),
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
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableDatabase",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which lists databases by name and returns plain
      // attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.D1.Database("AdoptableDatabase", {
            name: databaseName,
          });
        }),
      );

      // Same physical database — adoption, not re-creation.
      expect(adopted.databaseId).toEqual(initialId);
      expect(adopted.databaseName).toEqual(databaseName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableDatabase",
        });
      }).pipe(Effect.provide(stack.state));

      expect((persisted as any)?.attr).toMatchObject({
        databaseId: initialId,
        databaseName,
      });

      yield* stack.destroy();
      yield* waitForDatabaseToBeDeleted(initialId, accountId);
    }).pipe(logLevel),
);

const waitForDatabaseToBeDeleted = Effect.fn(function* (
  databaseId: string,
  accountId: string,
) {
  yield* d1
    .getDatabase({
      accountId,
      databaseId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists =>
          e instanceof DatabaseStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("DatabaseNotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
class EmptyResults extends Data.TaggedError("EmptyResults")<{
  sql: string;
}> {}
