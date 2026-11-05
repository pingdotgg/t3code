import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const createdAt = "2026-09-01T00:00:00.000Z";

layer("080_RemoveWorktreeWorkspaceStrategies", (it) => {
  it.effect("moves worktree workspace strategies to root and keeps the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      for (const [taskId, strategy] of [
        ["worktree-task", '{"type":"worktree","baseRef":"main"}'],
        ["existing-task", '{"type":"existing_worktree","worktreePath":"/repo/.wt"}'],
        ["root-task", '{"type":"root","branch":"dev"}'],
      ] as const) {
        yield* sql`
          INSERT INTO scheduled_tasks (
            task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
            model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
            created_at, updated_at, last_run_status, run_count
          ) VALUES (
            ${taskId}, ${taskId}, 'prompt', 1, '{}', 'project-1', ${strategy},
            '{}', 'full-access', 'default', 'user', 'web',
            ${createdAt}, ${createdAt}, 'never', 0
          )
        `;
      }
      const runs = [
        [
          "run-worktree",
          '{"id":"run-worktree","workspacePreparation":{"type":"worktree","baseRef":"main"}}',
        ],
        [
          "run-existing",
          '{"id":"run-existing","workspacePreparation":{"type":"existing_worktree","worktreePath":"/x"}}',
        ],
        ["run-root", '{"id":"run-root","workspacePreparation":{"type":"root"}}'],
        ["run-none", '{"id":"run-none"}'],
      ] as const;
      for (const [ordinal, [runId, payload]] of runs.entries()) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, status, requested_at, payload_json
          ) VALUES (${runId}, 'thread-1', ${ordinal + 1}, 'codex', 'completed', ${createdAt}, ${payload})
        `;
      }

      yield* runMigrations();

      const tasks = yield* sql<{ task_id: string; workspace_strategy_json: string }>`
        SELECT task_id, workspace_strategy_json FROM scheduled_tasks ORDER BY task_id
      `;
      assert.deepStrictEqual(
        tasks.map((row) => [row.task_id, JSON.parse(row.workspace_strategy_json)]),
        [
          ["existing-task", { type: "root" }],
          ["root-task", { type: "root", branch: "dev" }],
          ["worktree-task", { type: "root" }],
        ],
      );

      const storedRuns = yield* sql<{ run_id: string; payload_json: string }>`
        SELECT run_id, payload_json FROM orchestration_v2_projection_runs ORDER BY run_id
      `;
      assert.deepStrictEqual(
        storedRuns.map((row) => [row.run_id, JSON.parse(row.payload_json)]),
        [
          ["run-existing", { id: "run-existing", workspacePreparation: { type: "root" } }],
          ["run-none", { id: "run-none" }],
          ["run-root", { id: "run-root", workspacePreparation: { type: "root" } }],
          ["run-worktree", { id: "run-worktree", workspacePreparation: { type: "root" } }],
        ],
      );
    }),
  );
});
