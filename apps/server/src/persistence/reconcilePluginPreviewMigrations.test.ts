import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PluginInstallations from "./Migrations/076_PluginInstallations.ts";
import PluginEventCursors from "./Migrations/077_PluginEventCursors.ts";

const previews = [
  [67, "PluginInstallations", PluginInstallations],
  [68, "PluginEventCursors", PluginEventCursors],
] as const;
const seed = (through: number, start = 67) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: start - 1 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          previews
            .filter(([id]) => start + id - 67 <= through)
            .map(([id, name, migration]) => [`${start + id - 67}_${name}`, migration]),
        ),
      ),
    });
    yield* sql`INSERT INTO plugin_installations VALUES ('sentinel', '/plugins/sentinel', '{"consent":"retained"}')`;
    if (through >= start + 1)
      yield* sql`INSERT INTO plugin_event_cursors VALUES ('sentinel', 321, 'retained-time')`;
    yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-01 00:00:00' WHERE migration_id >= ${start}`;
  });
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schema = yield* sql<{
    readonly name: string;
    readonly type: string;
    readonly sql: string | null;
  }>`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
  const data = [];
  for (const row of schema) {
    if (
      row.type === "table" &&
      (row.name.startsWith("plugin_") || row.name === "effect_sql_migrations")
    )
      data.push([row.name, yield* sql.unsafe(`SELECT * FROM "${row.name}" ORDER BY 1`)]);
  }
  return { schema, data };
});
const assertCurrent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(
    (yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`).map(
      (row) => [row.migration_id, row.name] as const,
    ),
    migrationManifest,
  );
  assert.strictEqual(
    (yield* sql`PRAGMA table_info(scheduled_tasks)`).some(
      (row) => row.name === "last_run_webhook_delivery_id",
    ),
    true,
  );
  assert.strictEqual(
    (yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'`)
      .length,
    1,
  );
});
const memory = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  test.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

describe("plugin preview upgrade", () => {
  it.effect.each([0, 68, 75])("upgrades fresh/main %s with canonical migration ids", (main) =>
    memory(
      Effect.gen(function* () {
        if (main) yield* runMigrations({ toMigrationInclusive: main });
        yield* runMigrations();
        yield* assertCurrent;
        const before = yield* snapshot;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    ),
  );
  it.effect.each([[67, 67], [68, 67], [69, 69], [70, 69]] as const)(
    "preserves preview %s data and timestamps and is reentrant",
    ([through, start]) =>
      memory(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seed(through, start);
          const before = (yield* snapshot).data.filter(
            ([name]) => name !== "effect_sql_migrations",
          );
          yield* runMigrations();
          yield* assertCurrent;
          const after = yield* snapshot;
          // A later canonical build can add tables, but existing rows stay byte-for-byte identical.
          for (const table of before)
            assert.deepStrictEqual(
              after.data.find(([name]) => name === table[0]),
              table,
            );
          assert.deepStrictEqual(
            yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id BETWEEN 76 AND ${76 + through - start}`,
            Array.from({ length: through - start + 1 }, () => ({ created_at: "2026-10-01 00:00:00" })),
          );
          assert.deepStrictEqual(yield* runMigrations(), []);
          assert.deepStrictEqual(yield* snapshot, after);
        }),
      ),
  );
  it.effect.each(["unknown-history", "unknown-schema", "partial-upstream", "partial-search", "partial-target"])(
    "rejects %s unchanged",
    (variant) =>
      memory(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seed(67);
          if (variant === "unknown-history")
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (68, 'UnknownFork')`;
          if (variant === "unknown-schema")
            yield* sql`ALTER TABLE plugin_installations ADD COLUMN unknown TEXT`;
          if (variant === "partial-upstream")
            yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_webhook_delivery_id TEXT`;
          if (variant === "partial-search")
            yield* sql`CREATE TABLE orchestration_v2_message_search (text TEXT)`;
          const before = yield* snapshot;
          assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations(variant === "partial-target" ? { toMigrationInclusive: 75 } : {}))));
          assert.deepStrictEqual(yield* snapshot, before);
        }),
      ),
  );
  it.effect("rolls back ledger moves and upstream schema on SQL failure, then retries", () =>
    memory(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seed(67);
        yield* sql`CREATE TRIGGER refuse_plugin_upgrade BEFORE INSERT ON effect_sql_migrations WHEN NEW.name = 'ShellStopRequestIndex' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
        const before = yield* snapshot;
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(yield* snapshot, before);
        yield* sql`DROP TRIGGER refuse_plugin_upgrade`;
        yield* runMigrations();
        yield* assertCurrent;
      }),
    ),
  );
});
