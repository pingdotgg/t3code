import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ProjectionThreadMessageSearch", (it) => {
  it.effect("backfills settled user messages and ignores streaming updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, pending_runtime_mode,
          interaction_mode, branch, worktree_path, review_snapshot_json, review_result_json,
          latest_turn_id, created_at, updated_at, archived_at, latest_user_message_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan, deleted_at
        ) VALUES (
          'thread-search', 'project-search', 'Search thread', '{"instanceId":"codex","model":"x"}',
          'full-access', 'full-access', 'default', NULL, NULL, 'null', 'null', NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL, 0, 0, 0, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('settled', 'thread-search', NULL, 'user', 'find src/routes', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('streaming', 'thread-search', NULL, 'assistant', 'partial src/routes', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 48 });

      const initial = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM projection_thread_message_fts WHERE projection_thread_message_fts MATCH '"src/routes"'
      `;
      assert.equal(initial[0]?.count, 1);

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'find src/components', updated_at = '2026-01-01T00:00:01.000Z'
        WHERE message_id = 'settled'
      `;
      const afterSettledUpdate = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM projection_thread_message_fts
        WHERE projection_thread_message_fts MATCH '"src/components"'
      `;
      assert.equal(afterSettledUpdate[0]?.count, 1);
      const afterSettledUpdateOldText = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM projection_thread_message_fts
        WHERE projection_thread_message_fts MATCH '"src/routes"'
      `;
      assert.equal(afterSettledUpdateOldText[0]?.count, 0);

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'streaming delta src/routes', updated_at = '2026-01-01T00:00:01.000Z'
        WHERE message_id = 'streaming'
      `;
      const afterStreamingUpdate = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM projection_thread_message_fts WHERE projection_thread_message_fts MATCH '"delta"'
      `;
      assert.equal(afterStreamingUpdate[0]?.count, 0);

      yield* sql`
        UPDATE projection_thread_messages SET is_streaming = 0 WHERE message_id = 'streaming'
      `;
      const finalized = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM projection_thread_message_fts WHERE projection_thread_message_fts MATCH '"delta"'
      `;
      assert.equal(finalized[0]?.count, 1);
    }),
  );
});
