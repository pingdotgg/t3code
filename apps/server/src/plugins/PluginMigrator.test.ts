import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts/plugin";
import type { PluginMigration } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PluginMigratorModule from "./PluginMigrator.ts";
import { PluginMigrationDowngradeError, PluginMigrationViolation } from "./PluginMigrator.ts";

const layer = it.layer(
  PluginMigratorModule.layer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const pluginPrefix = (pluginId: PluginId) => `p_${pluginId.replaceAll("-", "_")}_`;

const migration = (
  version: number,
  name: string,
  statements: string | ReadonlyArray<string>,
): PluginMigration => ({
  version,
  name,
  up: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of Array.isArray(statements) ? statements : [statements]) {
      yield* sql.unsafe(statement).unprepared;
    }
  }),
});

const setup = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 34 });
  return yield* PluginMigratorModule.PluginMigrator;
});

layer("PluginMigrator", (it) => {
  it.effect("runs migrations once and records applied rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("test-plugin");
      const prefix = pluginPrefix(pluginId);
      const migrations = [
        migration(1, "Init", `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`),
      ];

      yield* migrator.run(pluginId, migrations);
      yield* migrator.run(pluginId, migrations);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM plugin_migrations WHERE plugin_id = ${pluginId}
      `;
      assert.equal(rows[0]?.count, 1);
    }),
  );

  it.effect("refuses downgrades when recorded head exceeds provided migrations", () =>
    Effect.gen(function* () {
      const migrator = yield* setup;
      const pluginId = PluginId.make("downgrade-plugin");
      const prefix = pluginPrefix(pluginId);

      yield* migrator.run(pluginId, [
        migration(1, "Init", `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`),
        migration(2, "Next", `CREATE TABLE ${prefix}more (id TEXT PRIMARY KEY)`),
      ]);

      const result = yield* Effect.result(
        migrator.run(pluginId, [
          migration(1, "Init", `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`),
        ]),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationDowngradeError);
      }
    }),
  );

  it.effect("rolls back non-prefixed tables and does not record the row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("bad-table-plugin");

      const result = yield* Effect.result(
        migrator.run(pluginId, [migration(1, "Bad", "CREATE TABLE bad_items (id TEXT)")]),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name = 'bad_items'
      `;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM plugin_migrations WHERE plugin_id = ${pluginId}
      `;
      assert.deepEqual(tables, []);
      assert.equal(rows[0]?.count, 0);
    }),
  );

  it.effect("rejects triggers that reference pre-existing core tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("trigger-plugin");
      const prefix = pluginPrefix(pluginId);
      yield* sql`CREATE TABLE core_items (id TEXT PRIMARY KEY)`;

      const result = yield* Effect.result(
        migrator.run(pluginId, [
          migration(1, "Trigger", [
            `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`,
            `
              CREATE TRIGGER ${prefix}items_ai
              AFTER INSERT ON ${prefix}items
              BEGIN
                INSERT INTO core_items (id) VALUES (NEW.id);
              END
            `,
          ]),
        ]),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
    }),
  );

  it.effect("accepts a trigger that names a core table only inside a string literal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("literal-plugin");
      const prefix = pluginPrefix(pluginId);
      yield* sql`CREATE TABLE core_literal_ref (id TEXT PRIMARY KEY)`;

      yield* migrator.run(pluginId, [
        migration(1, "Literal", [
          `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`,
          `
            CREATE TRIGGER ${prefix}items_guard
            BEFORE INSERT ON ${prefix}items
            BEGIN
              SELECT RAISE(ABORT, 'cannot edit while core_literal_ref active');
            END
          `,
        ]),
      ]);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM plugin_migrations WHERE plugin_id = ${pluginId}
      `;
      assert.equal(rows[0]?.count, 1);
    }),
  );

  it.effect("accepts a trigger that names a core table only inside a line comment", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("line-comment-plugin");
      const prefix = pluginPrefix(pluginId);
      yield* sql`CREATE TABLE core_line_ref (id TEXT PRIMARY KEY)`;

      yield* migrator.run(pluginId, [
        migration(1, "Comment", [
          `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`,
          `
            CREATE TRIGGER ${prefix}items_ai
            AFTER INSERT ON ${prefix}items
            BEGIN
              -- mirrors the core_line_ref feed
              SELECT 1;
            END
          `,
        ]),
      ]);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM plugin_migrations WHERE plugin_id = ${pluginId}
      `;
      assert.equal(rows[0]?.count, 1);
    }),
  );

  it.effect("accepts a trigger that names a core table only inside a block comment", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("block-comment-plugin");
      const prefix = pluginPrefix(pluginId);
      yield* sql`CREATE TABLE core_block_ref (id TEXT PRIMARY KEY)`;

      yield* migrator.run(pluginId, [
        migration(1, "BlockComment", [
          `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`,
          `
            CREATE TRIGGER ${prefix}items_ai
            AFTER INSERT ON ${prefix}items
            BEGIN
              /* mirrors the core_block_ref feed */
              SELECT 1;
            END
          `,
        ]),
      ]);

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM plugin_migrations WHERE plugin_id = ${pluginId}
      `;
      assert.equal(rows[0]?.count, 1);
    }),
  );

  it.effect("rejects a trigger that references a core table via a double-quoted identifier", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("quoted-ident-plugin");
      const prefix = pluginPrefix(pluginId);
      yield* sql`CREATE TABLE core_quoted_ref (id TEXT PRIMARY KEY)`;

      // Double quotes are quoted identifiers in SQLite, so "core_quoted_ref" is a
      // real table reference and must stay caught even though single-quoted
      // literals and comments are stripped before the scan.
      const result = yield* Effect.result(
        migrator.run(pluginId, [
          migration(1, "QuotedRef", [
            `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`,
            `
              CREATE TRIGGER ${prefix}items_ai
              AFTER INSERT ON ${prefix}items
              BEGIN
                INSERT INTO "core_quoted_ref" (id) VALUES (NEW.id);
              END
            `,
          ]),
        ]),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
    }),
  );

  it.effect("rejects a plugin-named index anchored to a core table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("core-index-plugin");
      yield* sql`CREATE TABLE core_notes (body TEXT)`;

      // The index NAME is inside the plugin namespace, which is all the old gate
      // looked at — and index/table types then `continue`d past every other check.
      // The anchor is what matters: a UNIQUE index on a core table changes that
      // table's write constraints, breaking future inserts, while the migration
      // recorded as successful.
      const result = yield* Effect.result(
        migrator.run(pluginId, [
          migration(
            1,
            "Sneaky index",
            "CREATE UNIQUE INDEX p_core_index_plugin_idx ON core_notes(body)",
          ),
        ]),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
      // Rolled back: the core table's constraints must be untouched.
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name = 'p_core_index_plugin_idx'
      `;
      assert.deepEqual(indexes, []);
    }),
  );

  it.effect("rejects migrations that drop objects outside the plugin namespace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("drop-plugin");
      yield* sql`CREATE TABLE core_victim (id TEXT PRIMARY KEY)`;

      const result = yield* Effect.result(
        migrator.run(pluginId, [migration(1, "Drop", "DROP TABLE core_victim")]),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name = 'core_victim'
      `;
      assert.equal(tables.length, 1);
    }),
  );

  it.effect("rejects migrations that rename a core table into the plugin namespace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("rename-plugin");
      const prefix = pluginPrefix(pluginId);
      yield* sql`CREATE TABLE core_renamed (id TEXT PRIMARY KEY)`;

      const result = yield* Effect.result(
        migrator.run(pluginId, [
          migration(1, "Rename", `ALTER TABLE core_renamed RENAME TO ${prefix}stolen`),
        ]),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name = 'core_renamed'
      `;
      assert.equal(tables.length, 1);
    }),
  );

  it.effect("rejects ATTACH DATABASE in plugin migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrator = yield* setup;
      const pluginId = PluginId.make("attach-plugin");

      // SQLite itself refuses ATTACH inside the migration transaction, so
      // this surfaces as a migration failure; the PRAGMA database_list gate
      // additionally covers a migration that breaks out of the transaction.
      const result = yield* Effect.result(
        migrator.run(pluginId, [
          migration(1, "Attach", [
            "ATTACH DATABASE ':memory:' AS escape_hatch",
            "CREATE TABLE escape_hatch.evil (id TEXT)",
          ]),
        ]),
      );

      assert.isTrue(Result.isFailure(result));
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM plugin_migrations WHERE plugin_id = ${pluginId}
      `;
      assert.equal(rows[0]?.count, 0);
    }),
  );

  it.effect("rejects TEMP objects in plugin migrations", () =>
    Effect.gen(function* () {
      const migrator = yield* setup;
      const pluginId = PluginId.make("temp-plugin");

      const result = yield* Effect.result(
        migrator.run(pluginId, [migration(1, "Temp", "CREATE TEMP TABLE sneaky (id TEXT)")]),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
    }),
  );

  it.effect("treats an empty migration list as a no-op even with recorded history", () =>
    Effect.gen(function* () {
      const migrator = yield* setup;
      const pluginId = PluginId.make("empty-plugin");
      const prefix = pluginPrefix(pluginId);

      yield* migrator.run(pluginId, [
        migration(1, "Init", `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`),
      ]);
      yield* migrator.run(pluginId, []);
    }),
  );

  it.effect("enforces prefixes for indexes and views", () =>
    Effect.gen(function* () {
      const migrator = yield* setup;
      const pluginId = PluginId.make("view-plugin");
      const prefix = pluginPrefix(pluginId);

      yield* migrator.run(pluginId, [
        migration(1, "Index", [
          `CREATE TABLE ${prefix}items (id TEXT PRIMARY KEY)`,
          `CREATE INDEX ${prefix}items_id_idx ON ${prefix}items (id)`,
        ]),
      ]);

      const result = yield* Effect.result(
        migrator.run(pluginId, [
          migration(2, "BadView", `CREATE VIEW bad_items_view AS SELECT id FROM ${prefix}items`),
        ]),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMigrationViolation);
      }
    }),
  );
});
