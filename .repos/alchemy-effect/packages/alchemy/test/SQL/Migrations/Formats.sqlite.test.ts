import {
  applyAlchemyFormat,
  applyMigrations,
  readDrizzleDirRecords,
  readFlatRecords,
} from "@/SQL/Migrations/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Database } from "bun:sqlite";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeSqliteExecutor, tableNames } from "./sqlite-executor.ts";

const fixture = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname;

const describe = layer(NodeServices.layer);

const ALCHEMY_COLUMNS = ["id", "hash", "created_at", "name", "applied_at"];

const migrationRows = (db: Database, table = "__alchemy_migrations") =>
  db
    .query(
      `SELECT hash, created_at, name, applied_at FROM ${table} ORDER BY id;`,
    )
    .all() as Array<{
    hash: string;
    created_at: number | null;
    name: string;
    applied_at: string | null;
  }>;

describe("alchemy format", (it) => {
  it.effect("creates the table and applies flat migrations in order", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const records = yield* readFlatRecords(fixture("flat"));
      yield* applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records,
      });

      expect(tableNames(db)).toEqual(
        expect.arrayContaining(["__alchemy_migrations", "posts", "users"]),
      );
      const columns = db
        .query("PRAGMA table_info(__alchemy_migrations);")
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);

      const rows = migrationRows(db);
      expect(rows.map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
      expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].applied_at).toBeTruthy();

      // Idempotent — a replay would throw on the bare CREATE TABLEs.
      yield* applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records,
      });
      expect(migrationRows(db).length).toBe(2);
    }),
  );

  it.effect("applies only pending migrations on subsequent runs", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const records = yield* readFlatRecords(fixture("flat"));
      yield* applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records: records.slice(0, 1),
      });
      yield* applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records,
      });
      expect(migrationRows(db).map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
    }),
  );

  it.effect(
    "upgrades the legacy Alchemy 3-column table in place without replaying",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // A pre-registry deploy: the invented shape, TEXT id.
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '0001_users.sql', '2024-01-01 00:00:00');",
        );
        // ...and migration 0001 really ran:
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        // Legacy deploys keep converging against their persisted table.
        yield* applyAlchemyFormat({
          executor,
          table: "d1_migrations",
          records,
        });

        const columns = db
          .query("PRAGMA table_info(d1_migrations);")
          .all() as Array<{ name: string; type: string }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);
        const rows = migrationRows(db, "d1_migrations");
        expect(rows.map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
        // Backfilled from the matching local record, not a placeholder.
        expect(rows[0].hash).toBe(records[0].hash);
        // The original applied_at survives the rebuild.
        expect(rows[0].applied_at).toBe("2024-01-01 00:00:00");
        expect(tableNames(db)).toContain("posts");
      }),
  );

  it.effect(
    "upgrades the oldest 2-column shape, reading names from the primary column",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE __alchemy_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO __alchemy_migrations (id, applied_at) VALUES ('0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });
        expect(migrationRows(db).map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
      }),
  );

  it.effect(
    "converts a wrangler-shaped table in place when it IS the resolved table",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "d1_migrations",
          records,
        });
        const columns = db
          .query("PRAGMA table_info(d1_migrations);")
          .all() as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);
        expect(migrationRows(db, "d1_migrations").map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
      }),
  );

  it.effect(
    "legacy rows recorded as dir/migration.sql keep matching directory records",
    () =>
      // Pre-registry Alchemy applied drizzle-layout dirs under the flat
      // key (`<dir>/migration.sql`); current records key them by `<dir>`.
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '20240101000000_init/migration.sql', '2024-01-01 00:00:00');",
        );
        db.run(
          "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
        );
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        yield* applyAlchemyFormat({
          executor,
          table: "d1_migrations",
          records,
        });
        expect(migrationRows(db, "d1_migrations").map((r) => r.name)).toEqual([
          "20240101000000_init/migration.sql",
          "20240102000000_add_posts",
        ]);
        expect(tableNames(db)).toContain("posts");
      }),
  );

  it.effect(
    "fails the upgrade when a recorded migration matches no local file",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE __alchemy_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO __alchemy_migrations (id, name, applied_at) VALUES ('00001', 'zzz_deleted.sql', '2024-01-01 00:00:00');",
        );
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
          expect(result.failure.message).toContain("zzz_deleted.sql");
        }
      }),
  );
});

describe("one-way conversion from foreign tables", (it) => {
  it.effect(
    "adopts a wrangler-migrated database: history copied, table frozen",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        // What `wrangler d1 migrations apply` left behind.
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });

        // History converted, only the pending migration ran.
        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
        expect(rows[0].hash).toBe(records[0].hash);
        expect(rows[0].applied_at).toBe("2024-01-01 00:00:00");

        // The wrangler table is frozen — never written, never dropped.
        const wrangler = db
          .query("SELECT name FROM d1_migrations ORDER BY id;")
          .all() as Array<{ name: string }>;
        expect(wrangler.map((r) => r.name)).toEqual(["0001_users.sql"]);
      }),
  );

  it.effect(
    "conversion fails when foreign history references a missing local file",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
        );
        db.run("INSERT INTO d1_migrations (name) VALUES ('zzz_gone.sql');");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
        }
      }),
  );

  it.effect(
    "adopts a state-lost legacy 3-column d1_migrations as a conversion source",
    () =>
      // Old Alchemy deploys wrote a 3-column d1_migrations; if state was
      // lost (adoption), the resolved table is __alchemy_migrations and
      // the legacy table must be picked up as a source, not replayed.
      Effect.gen(function* () {
        const db = new Database(":memory:");
        db.run(
          "CREATE TABLE d1_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
        );
        db.run(
          "INSERT INTO d1_migrations (id, name, applied_at) VALUES ('00001', '0001_users.sql', '2024-01-01 00:00:00');",
        );
        db.run(
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        );

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });

        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
        expect(rows[0].hash).toBe(records[0].hash);
        // The legacy table is frozen as a source, still 3 columns.
        const legacyColumns = db
          .query("PRAGMA table_info(d1_migrations);")
          .all() as Array<{ name: string }>;
        expect(legacyColumns.map((c) => c.name)).toEqual([
          "id",
          "name",
          "applied_at",
        ]);
      }),
  );

  it.effect("prefers drizzle history when multiple foreign sources exist", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
      // Both a drizzle table and a wrangler table exist; drizzle's is
      // probed first and carries hashes, so it wins.
      db.run(
        "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT);",
      );
      db.run(
        `INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('${records[0].hash}', 1704067200000, '20240101000000_init');`,
      );
      db.run(
        "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
      );
      db.run(
        "INSERT INTO d1_migrations (name) VALUES ('20240101000000_init');",
      );
      db.run(
        "CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);",
      );
      db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

      const executor = makeSqliteExecutor(db);
      yield* applyAlchemyFormat({
        executor,
        table: "__alchemy_migrations",
        records,
      });
      const rows = migrationRows(db);
      expect(rows.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_add_posts",
      ]);
      // Hash came from drizzle's table (wrangler has none).
      expect(rows[0].hash).toBe(records[0].hash);
    }),
  );

  it.effect("adopts a prisma-migrated database via _prisma_migrations", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      // Prisma's table shape (sqlite rendition), one applied + one
      // rolled-back migration.
      db.run(
        `CREATE TABLE _prisma_migrations (
           id TEXT PRIMARY KEY,
           checksum TEXT NOT NULL,
           finished_at TEXT,
           migration_name TEXT NOT NULL,
           logs TEXT,
           rolled_back_at TEXT,
           started_at TEXT NOT NULL,
           applied_steps_count INTEGER NOT NULL DEFAULT 0
         );`,
      );
      const records = yield* readDrizzleDirRecords(fixture("prisma"));
      db.run(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
         VALUES ('a', '${records[0].hash}', '2024-01-01 00:00:01', '20240101000000_init', '2024-01-01 00:00:00', 1);`,
      );
      db.run(
        `INSERT INTO _prisma_migrations (id, checksum, rolled_back_at, migration_name, started_at)
         VALUES ('b', 'dead', '2024-01-02 00:00:00', '20240102000000_rolled_back', '2024-01-02 00:00:00');`,
      );
      // The applied migration's tables exist (Prisma-dialect SQL in the
      // fixture is postgres-flavored, so create a stand-in):
      db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");

      const executor = makeSqliteExecutor(db);
      yield* applyAlchemyFormat({
        executor,
        // Only the applied row must convert; the rolled-back row is
        // skipped even though it has no local file.
        table: "__alchemy_migrations",
        records: records.slice(0, 1),
      });
      const rows = migrationRows(db);
      expect(rows.map((r) => r.name)).toEqual(["20240101000000_init"]);
      // Prisma's checksum is sha256 of migration.sql — carried verbatim.
      expect(rows[0].hash).toBe(records[0].hash);
      // Frozen source.
      expect(
        (
          db
            .query("SELECT COUNT(*) AS n FROM _prisma_migrations;")
            .all() as Array<{ n: number }>
        )[0].n,
      ).toBe(2);
    }),
  );

  it.effect("a failed prisma migration blocks conversion with guidance", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      db.run(
        `CREATE TABLE _prisma_migrations (
           id TEXT PRIMARY KEY,
           checksum TEXT NOT NULL,
           finished_at TEXT,
           migration_name TEXT NOT NULL,
           logs TEXT,
           rolled_back_at TEXT,
           started_at TEXT NOT NULL,
           applied_steps_count INTEGER NOT NULL DEFAULT 0
         );`,
      );
      db.run(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at)
         VALUES ('a', 'abc', '20240101000000_broken', '2024-01-01 00:00:00');`,
      );
      const executor = makeSqliteExecutor(db);
      const records = yield* readFlatRecords(fixture("flat"));
      const result = yield* Effect.result(
        applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("MigrationError");
        expect(result.failure.message).toContain("prisma migrate resolve");
      }
    }),
  );
});

describe("registry apply", (it) => {
  it.effect("keys directory-layout dirs by directory name", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      yield* applyMigrations({
        resolved: {
          dir: fixture("drizzle-v1"),
          table: "__alchemy_migrations",
        },
        executor,
      });
      expect(migrationRows(db).map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_add_posts",
      ]);
    }),
  );

  it.effect("rejects drizzle-v0 layouts", () =>
    Effect.gen(function* () {
      const db = new Database(":memory:");
      const executor = makeSqliteExecutor(db);
      const result = yield* Effect.result(
        applyMigrations({
          resolved: {
            dir: fixture("drizzle-v0"),
            table: "__alchemy_migrations",
          },
          executor,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("DrizzleV0LayoutError");
      }
    }),
  );
});
