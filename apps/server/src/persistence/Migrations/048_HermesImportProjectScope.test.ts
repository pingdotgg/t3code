import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_HermesImportProjectScope", (it) => {
  it.effect("backfills legacy import rows from their thread and drops unrecoverable rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`DROP INDEX hermes_session_imports_stored_identity_idx`;
      yield* sql`DROP INDEX hermes_session_imports_one_main_idx`;
      yield* sql`DROP TABLE hermes_session_imports`;
      yield* sql`
        CREATE TABLE hermes_session_imports (
          import_id TEXT PRIMARY KEY,
          provider_instance_id TEXT NOT NULL,
          profile_key TEXT NOT NULL,
          import_kind TEXT NOT NULL,
          stored_session_key TEXT,
          thread_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id,
          project_id,
          title,
          default_provider,
          runtime_mode,
          interaction_mode,
          active_provider_thread_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at,
          payload_json
        ) VALUES (
          'thread:imported',
          'project:t3-work',
          'Imported',
          'hermes',
          'full-access',
          'default',
          NULL,
          '2026-07-26T12:00:00.000Z',
          '2026-07-26T12:00:00.000Z',
          NULL,
          NULL,
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO hermes_session_imports VALUES
          (
            'import:resolved',
            'hermes-local',
            'default',
            'session',
            'stored:resolved',
            'thread:imported',
            'completed',
            '2026-07-26T12:00:00.000Z',
            '2026-07-26T12:00:00.000Z'
          ),
          (
            'import:unresolved',
            'hermes-local',
            'default',
            'session',
            'stored:unresolved',
            'thread:missing',
            'prepared',
            '2026-07-26T12:00:00.000Z',
            '2026-07-26T12:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(hermes_session_imports)
      `;
      assert.include(
        columns.map(({ name }) => name),
        "project_id",
      );
      const rows = yield* sql<{
        readonly import_id: string;
        readonly project_id: string;
      }>`
        SELECT import_id, project_id
        FROM hermes_session_imports
        ORDER BY import_id
      `;
      assert.deepStrictEqual(rows, [
        { import_id: "import:resolved", project_id: "project:t3-work" },
      ]);
    }),
  );
});
