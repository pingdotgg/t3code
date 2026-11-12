import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const OPTIONS = [{ id: "effort", value: "max" }];
/** What migration 026 wrote on SQLite 3.54+: the options array as a JSON string. */
const stringified = (selection: Record<string, unknown>) =>
  JSON.stringify({ ...selection, options: JSON.stringify(OPTIONS) });
const selection = { provider: "claudeAgent", model: "claude-opus-4-6" };

layer("fork/020_RepairStringifiedModelSelectionOptions", (it) => {
  it.effect("parses options 026 stored as strings and leaves every other shape alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 26 });

      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, default_model_selection_json, scripts_json,
           created_at, updated_at, deleted_at)
        VALUES
          ('project-broken', 'P', '/tmp/p', ${stringified(selection)}, '[]', 'c', 'u', NULL),
          ('project-text', 'P', '/tmp/t', ${JSON.stringify({ ...selection, options: "not json" })},
            '[]', 'c', 'u', NULL)
      `;
      const thread = (id: string, modelSelection: string) => sql`
        INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, branch, worktree_path,
           latest_turn_id, created_at, updated_at, archived_at, latest_user_message_at,
           pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
           deleted_at, runtime_mode, interaction_mode)
        VALUES (${id}, 'project-broken', 'T', ${modelSelection}, NULL, NULL, NULL, 'c', 'u',
          NULL, NULL, 0, 0, 0, NULL, 'full-access', 'default')
      `;
      yield* thread("thread-broken", stringified(selection));
      yield* thread("thread-canonical", JSON.stringify({ ...selection, options: OPTIONS }));
      const event = (id: string, type: string, payload: Record<string, unknown>) => sql`
        INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
           command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
        VALUES (${id}, ${type.split(".")[0]!}, ${id}, 1, ${type}, 'o', ${id}, NULL, ${id}, 'user',
          ${JSON.stringify(payload)}, '{}')
      `;
      yield* event("event-thread", "thread.created", {
        modelSelection: { ...selection, options: JSON.stringify(OPTIONS) },
      });
      yield* event("event-project", "project.meta-updated", {
        defaultModelSelection: { ...selection, options: JSON.stringify(OPTIONS) },
      });

      yield* runMigrations();

      const options = (json: string | null) => JSON.parse(json ?? "null")?.options;
      const projects = yield* sql<{ id: string; json: string | null }>`
        SELECT project_id AS id, default_model_selection_json AS json
        FROM projection_projects ORDER BY project_id`;
      assert.deepEqual(
        projects.map((row) => [row.id, options(row.json)]),
        [
          ["project-broken", OPTIONS],
          ["project-text", "not json"],
        ],
      );
      const threads = yield* sql<{ id: string; json: string | null }>`
        SELECT thread_id AS id, model_selection_json AS json
        FROM projection_threads ORDER BY thread_id`;
      assert.deepEqual(
        threads.map((row) => [row.id, options(row.json)]),
        [
          ["thread-broken", OPTIONS],
          ["thread-canonical", OPTIONS],
        ],
      );
      const events = yield* sql<{ id: string; json: string }>`
        SELECT event_id AS id, payload_json AS json FROM orchestration_events
        WHERE event_id IN ('event-thread', 'event-project') ORDER BY event_id`;
      assert.deepEqual(
        events.map((row) => {
          const payload = JSON.parse(row.json);
          return [row.id, (payload.modelSelection ?? payload.defaultModelSelection).options];
        }),
        [
          ["event-project", OPTIONS],
          ["event-thread", OPTIONS],
        ],
      );
    }),
  );
});
