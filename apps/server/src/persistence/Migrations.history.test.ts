import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const seedHistorical = Effect.fn("seedHistorical")(function* (base: number, count: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: base });
  for (const [id, name, migration] of migrationEntries.filter(
    ([id]) => id >= 48 && id < 48 + count,
  )) {
    yield* migration;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${base + 1 + id - 48}, ${name})`;
  }
});

for (const [base, count] of [
  [43, 9],
  [44, 9],
  [44, 11],
  [43, 1],
  [44, 5],
] as const) {
  it.effect(`upgrades historical V2 ${base + 1}–${base + count} without replaying its DDL`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedHistorical(base, count);
      yield* runMigrations();
      const rows = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        rows.map(({ migration_id, name }) => [migration_id, name] as const),
        migrationManifest,
      );
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
      assert.ok(columns.some(({ name }) => name === "auto_pull"));
      assert.ok(columns.some(({ name }) => name === "project_icon_json"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("preserves the historical manifest when a missing main migration fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedHistorical(44, 9);
    yield* sql`ALTER TABLE projection_thread_messages RENAME TO unavailable_messages`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const result = yield* Effect.exit(runMigrations());
    assert.strictEqual(result._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
    assert.ok(!columns.some(({ name }) => name === "auto_pull"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects an unknown migration in a historical cohort without changing it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedHistorical(44, 9);
    yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownMigration' WHERE migration_id = 50`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.strictEqual((yield* Effect.exit(runMigrations()))._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back reconciliation when a later V2 migration fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedHistorical(44, 11);
    yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_thread_run_idx ON orchestration_v2_projection_turn_items(thread_id, run_id)`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.strictEqual((yield* Effect.exit(runMigrations()))._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
    assert.ok(!columns.some(({ name }) => name === "auto_pull"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("preserves V2 import progress and original migration timestamps", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedHistorical(43, 9);
    yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, imported_message_count) VALUES ('thread-1', '2026-09-01', '2026-09-02', 123)`;
    yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-09-01 00:00:00' WHERE migration_id = 44`;
    const before = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, before);
    assert.deepStrictEqual(
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 48`,
      [{ created_at: "2026-09-01 00:00:00" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects a historical migration ceiling below the required main schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedHistorical(43, 9);
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.strictEqual(
      (yield* Effect.exit(runMigrations({ toMigrationInclusive: 46 })))._tag,
      "Failure",
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
