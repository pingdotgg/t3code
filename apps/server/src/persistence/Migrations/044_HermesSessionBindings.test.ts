import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_HermesSessionBindings", (it) => {
  it.effect("registers a privacy-minimized binding and mutation-intent schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 44
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 44,
          name: "HermesSessionBindings",
        },
      ]);

      const bindingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(hermes_session_bindings)
      `;
      const intentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(hermes_mutation_intents)
      `;
      const importColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(hermes_session_imports)
      `;
      assert.deepStrictEqual(
        bindingColumns.map(({ name }) => name),
        [
          "binding_id",
          "provider_instance_id",
          "profile_key",
          "project_id",
          "stored_session_key",
          "thread_id",
          "protocol_classification",
          "protocol_major",
          "protocol_minor",
          "capabilities_json",
          "reconciliation_cursor",
          "reconciliation_fingerprint",
          "lease_owner_key",
          "lease_generation",
          "lease_expires_at",
          "created_at",
          "updated_at",
        ],
      );
      assert.deepStrictEqual(
        intentColumns.map(({ name }) => name),
        [
          "operation_id",
          "binding_id",
          "provider_instance_id",
          "profile_key",
          "project_id",
          "thread_id",
          "run_id",
          "attempt_id",
          "message_id",
          "mutation_kind",
          "method",
          "payload_digest",
          "owner_generation",
          "state",
          "prepared_at",
          "admitted_at",
          "settled_at",
          "updated_at",
        ],
      );
      assert.deepStrictEqual(
        importColumns.map(({ name }) => name),
        [
          "import_id",
          "provider_instance_id",
          "profile_key",
          "project_id",
          "import_kind",
          "stored_session_key",
          "thread_id",
          "state",
          "created_at",
          "updated_at",
        ],
      );

      const forbiddenColumns = new Set([
        "session_id",
        "token",
        "prompt",
        "transcript",
        "payload",
        "payload_json",
      ]);
      assert.ok(
        [...bindingColumns, ...intentColumns, ...importColumns].every(
          ({ name }) => !forbiddenColumns.has(name),
        ),
      );

      const unsettledPromptIndex = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'hermes_mutation_intents_one_unsettled_prompt_idx'
      `;
      assert.match(unsettledPromptIndex[0]!.sql, /CREATE UNIQUE INDEX/);
      assert.match(
        unsettledPromptIndex[0]!.sql,
        /state IN \('prepared', 'admitted', 'indeterminate'\)/,
      );

      const unsettledCreateIndex = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'hermes_mutation_intents_one_unsettled_create_idx'
      `;
      assert.match(
        unsettledCreateIndex[0]!.sql,
        /provider_instance_id, profile_key, project_id, thread_id/,
      );

      const oneMainIndex = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'hermes_session_imports_one_main_idx'
      `;
      assert.match(oneMainIndex[0]!.sql, /CREATE UNIQUE INDEX/);
      assert.match(oneMainIndex[0]!.sql, /WHERE import_kind = 'main'/);
    }),
  );
});
