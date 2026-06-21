import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_BackfillEmptyProjectionThreadRootIds", (it) => {
  it.effect("backfills empty root thread ids left by earlier projection rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          parent_kind,
          root_thread_id,
          parent_thread_id,
          parent_turn_id,
          parent_item_id,
          parent_activity_sequence,
          provider_thread_id,
          title_seed,
          subagent_depth,
          subagent_started_at,
          subagent_completed_at,
          subagent_status,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-empty-root',
          'project-empty-root',
          'Empty root id',
          '{"instanceId":"codex","model":"gpt-5.5","options":[]}',
          'full-access',
          'default',
          NULL,
          NULL,
          'root',
          '',
          NULL,
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          '2026-06-12T00:00:00.000Z',
          '2026-06-12T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{ readonly rootThreadId: string }>`
        SELECT root_thread_id AS "rootThreadId"
        FROM projection_threads
        WHERE thread_id = 'thread-empty-root'
      `;

      assert.deepStrictEqual(rows, [{ rootThreadId: "thread-empty-root" }]);
    }),
  );
});
