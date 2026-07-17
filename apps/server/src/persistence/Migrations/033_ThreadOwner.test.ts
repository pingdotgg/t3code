import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ThreadOwner", (it) => {
  it.effect("adds a non-null user owner default to projection_threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* runMigrations({ toMigrationInclusive: 33 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      const ownerColumn = columns.find((column) => column.name === "owner");
      assert.ok(ownerColumn);
      assert.equal(ownerColumn.notnull, 1);
      assert.equal(ownerColumn.dflt_value, "'user'");

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
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-default-owner',
          'project-1',
          'Default owner',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-06-01T00:00:00.000Z',
          '2026-06-01T00:00:00.000Z',
          NULL,
          NULL
        )
      `;

      const rows = yield* sql<{ readonly owner: string }>`
        SELECT owner FROM projection_threads WHERE thread_id = 'thread-default-owner'
      `;
      assert.equal(rows[0]?.owner, "user");
    }),
  );
});
