import { Database } from "bun:sqlite";
import {
  applyAlchemyFormat,
  applyMigrations,
  MigrationError,
  readDrizzleDirRecords,
  readFlatRecords,
  type SqlExecutor,
} from "@alchemy.run/sql/Migrations";
import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeSqliteExecutor, tableNames } from "./sqlite-executor.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

const describe = layer(NodeServices.layer);

const ALCHEMY_COLUMNS = ["id", "hash", "created_at", "name", "applied_at"];

const migrationRows = (db: Database, table = "__alchemy_migrations") =>
  db.query(`SELECT hash, created_at, name, applied_at FROM ${table} ORDER BY id;`).all() as Array<{
    hash: string;
    created_at: number | null;
    name: string;
    applied_at: string | null;
  }>;

// Fails `0001_users.sql` batches the way a data API can (#1889): `"lost"` runs
// the batch and then fails the reply, `"dropped"` fails before running it.
// `transient` is the flag the transport sets on the failure, `failures` is how
// many sends fail, and `failLedgerRead` fails the ledger read that follows a
// failed send.
const flakyBatches = (
  executor: SqlExecutor,
  options: {
    fault: "lost" | "dropped";
    transient: boolean;
    failures?: number;
    failLedgerRead?: boolean;
  },
): SqlExecutor & { sends: () => number } => {
  const { fault, transient, failures = 1, failLedgerRead = false } = options;
  let sends = 0;
  let failed = false;
  return {
    ...executor,
    sends: () => sends,
    query: (sql, params) =>
      failed && failLedgerRead
        ? Effect.fail(new MigrationError({ message: "ledger read failed", transient: true }))
        : executor.query(sql, params),
    batch: (statements) =>
      Effect.gen(function* () {
        // Only the migration's own batch, not the bookkeeping table's setup.
        if (!statements.some((statement) => statement.includes("CREATE TABLE users"))) {
          return yield* executor.batch(statements);
        }
        sends++;
        if (sends > failures) return yield* executor.batch(statements);
        if (fault === "lost") yield* executor.batch(statements);
        failed = true;
        return yield* new MigrationError({ message: "503 Service Unavailable", transient });
      }),
  };
};

describe("alchemy format", (it) => {
  it.effect(
    "does not resend a batch that landed before its reply was lost",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), { fault: "lost", transient: true });
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: records.slice(0, 1),
        });
        // A resend would fail on the bare CREATE TABLE.
        expect(executor.sends()).toBe(1);
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "resends a transient batch failure that did not land",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: true,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: records.slice(0, 1),
        });
        expect(executor.sends()).toBe(2);
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails when the resend fails too, without sending a third time",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: true,
          failures: 2,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(0, 1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationError");
          expect(result.failure.message).toContain("503");
        }
        expect(executor.sends()).toBe(2);
        expect(migrationRows(db)).toEqual([]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails without resending when the ledger cannot be read after a failure",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: true,
          failLedgerRead: true,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(0, 1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationError");
          expect(result.failure.message).toContain("ledger read failed");
        }
        expect(executor.sends()).toBe(1);
        expect(migrationRows(db)).toEqual([]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails a non-transient batch failure without resending it",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = flakyBatches(makeSqliteExecutor(db), {
          fault: "dropped",
          transient: false,
        });
        const records = yield* readFlatRecords(fixture("flat"));
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(0, 1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("MigrationError");
        expect(executor.sends()).toBe(1);
        expect(migrationRows(db)).toEqual([]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "creates the table and applies flat migrations in order",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        expect(tableNames(db)).toEqual(
          expect.arrayContaining(["__alchemy_migrations", "posts", "users"]),
        );
        const columns = db.query("PRAGMA table_info(__alchemy_migrations);").all() as Array<{
          name: string;
        }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);

        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0].applied_at).toBeTruthy();

        // Idempotent — a replay would throw on the bare CREATE TABLEs.
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        expect(migrationRows(db).length).toBe(2);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "applies only pending migrations on subsequent runs",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records: records.slice(0, 1),
        });
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
      }),
    { tags: ["unit", "local"] },
  );

  // #1389: name-keyed skip used to ignore content hashes, then the
  // resource persisted the new hashes as if the rewrite had applied.
  it.effect(
    "fails when an already-applied migration's contents changed",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });
        const rewritten = [
          {
            ...records[0],
            hash: "a".repeat(64),
            sql: "SELECT 1;",
            statements: ["SELECT 1;"],
          },
          records[1],
        ];
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: rewritten,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("RewrittenMigrationHistoryError");
          expect(result.failure.message).toContain("0001_users.sql");
        }
        expect(migrationRows(db).map((r) => r.hash)).toEqual(records.map((r) => r.hash));
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "fails when an already-applied migration file is removed",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({
          executor,
          table: "__alchemy_migrations",
          records,
        });
        const result = yield* Effect.result(
          applyAlchemyFormat({
            executor,
            table: "__alchemy_migrations",
            records: records.slice(1),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("RewrittenMigrationHistoryError");
          expect(result.failure.message).toContain("0001_users.sql");
        }
      }),
    { tags: ["unit", "local"] },
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
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        // Legacy deploys keep converging against their persisted table.
        yield* applyAlchemyFormat({ executor, table: "d1_migrations", records });

        const columns = db.query("PRAGMA table_info(d1_migrations);").all() as Array<{
          name: string;
          type: string;
        }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);
        const rows = migrationRows(db, "d1_migrations");
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        // Backfilled from the matching local record, not a placeholder.
        expect(rows[0].hash).toBe(records[0].hash);
        // The original applied_at survives the rebuild.
        expect(rows[0].applied_at).toBe("2024-01-01 00:00:00");
        expect(tableNames(db)).toContain("posts");
      }),
    { tags: ["unit", "local"] },
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
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        expect(migrationRows(db).map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
      }),
    { tags: ["unit", "local"] },
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
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "d1_migrations", records });
        const columns = db.query("PRAGMA table_info(d1_migrations);").all() as Array<{
          name: string;
        }>;
        expect(columns.map((c) => c.name)).toEqual(ALCHEMY_COLUMNS);
        expect(migrationRows(db, "d1_migrations").map((r) => r.name)).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);
      }),
    { tags: ["unit", "local"] },
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
        db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
        yield* applyAlchemyFormat({ executor, table: "d1_migrations", records });
        expect(migrationRows(db, "d1_migrations").map((r) => r.name)).toEqual([
          "20240101000000_init/migration.sql",
          "20240102000000_add_posts",
        ]);
        expect(tableNames(db)).toContain("posts");
      }),
    { tags: ["unit", "local"] },
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
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
          expect(result.failure.message).toContain("zzz_deleted.sql");
        }
      }),
    { tags: ["unit", "local"] },
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
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        // History converted, only the pending migration ran.
        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        expect(rows[0].hash).toBe(records[0].hash);
        expect(rows[0].applied_at).toBe("2024-01-01 00:00:00");

        // The wrangler table is frozen — never written, never dropped.
        const wrangler = db.query("SELECT name FROM d1_migrations ORDER BY id;").all() as Array<{
          name: string;
        }>;
        expect(wrangler.map((r) => r.name)).toEqual(["0001_users.sql"]);
      }),
    { tags: ["unit", "local"] },
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
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationHistoryConflictError");
        }
      }),
    { tags: ["unit", "local"] },
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
        db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");

        const executor = makeSqliteExecutor(db);
        const records = yield* readFlatRecords(fixture("flat"));
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });

        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
        expect(rows[0].hash).toBe(records[0].hash);
        // The legacy table is frozen as a source, still 3 columns.
        const legacyColumns = db.query("PRAGMA table_info(d1_migrations);").all() as Array<{
          name: string;
        }>;
        expect(legacyColumns.map((c) => c.name)).toEqual(["id", "name", "applied_at"]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "prefers drizzle history when multiple foreign sources exist",
    () =>
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
        db.run("INSERT INTO d1_migrations (name) VALUES ('20240101000000_init');");
        db.run("CREATE TABLE users (id integer PRIMARY KEY NOT NULL, name text NOT NULL);");
        db.run("CREATE UNIQUE INDEX users_name_unique ON users (name);");

        const executor = makeSqliteExecutor(db);
        yield* applyAlchemyFormat({ executor, table: "__alchemy_migrations", records });
        const rows = migrationRows(db);
        expect(rows.map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
        // Hash came from drizzle's table (wrangler has none).
        expect(rows[0].hash).toBe(records[0].hash);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "adopts a prisma-migrated database via _prisma_migrations",
    () =>
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
            db.query("SELECT COUNT(*) AS n FROM _prisma_migrations;").all() as Array<{ n: number }>
          )[0].n,
        ).toBe(2);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "a failed prisma migration blocks conversion with guidance",
    () =>
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
          applyAlchemyFormat({ executor, table: "__alchemy_migrations", records }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("MigrationError");
          expect(result.failure.message).toContain("prisma migrate resolve");
        }
      }),
    { tags: ["unit", "local"] },
  );
});

describe("registry apply", (it) => {
  it.effect(
    "keys directory-layout dirs by directory name",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        yield* applyMigrations({
          resolved: { dir: fixture("drizzle-v1"), table: "__alchemy_migrations" },
          executor,
        });
        expect(migrationRows(db).map((r) => r.name)).toEqual([
          "20240101000000_init",
          "20240102000000_add_posts",
        ]);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "rejects drizzle-v0 layouts",
    () =>
      Effect.gen(function* () {
        const db = new Database(":memory:");
        const executor = makeSqliteExecutor(db);
        const result = yield* Effect.result(
          applyMigrations({
            resolved: { dir: fixture("drizzle-v0"), table: "__alchemy_migrations" },
            executor,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("DrizzleV0LayoutError");
        }
      }),
    { tags: ["unit", "local"] },
  );
});
