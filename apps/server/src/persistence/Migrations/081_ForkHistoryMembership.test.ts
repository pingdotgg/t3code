import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("081_ForkHistoryMembership", (it) => {
  it.effect("reconstructs event-ordered membership and freezes conservative pruned history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      const now = "2026-01-01T00:00:00.000Z";
      for (const [id, status, ordinal] of [
        ["kept", "completed", 1],
        ["discarded", "rolled_back", 2],
        ["later-rewind", "rolled_back", 3],
        ["pruned-rewind", "rolled_back", 4],
        ["boundary", "completed", 5],
        ["future", "completed", 6],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, status, requested_at, payload_json
          ) VALUES (${id}, 'source', ${ordinal}, 'codex', ${status}, ${now}, ${JSON.stringify({ id, status })})
        `;
      }
      for (const [id, forkedFrom] of [
        ["fork", { type: "run", threadId: "source", runId: "boundary" }],
        ["empty", { type: "run", threadId: "source", runId: "missing" }],
        ["root", null],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, ${JSON.stringify({ forkedFrom })})
        `;
      }
      for (const [sequence, streamId, type, payload] of [
        [10, "source", "run.updated", { id: "pruned-rewind", status: "running" }],
        [101, "source", "run.created", { id: "discarded", status: "completed" }],
        [102, "source", "run.updated", { id: "discarded", status: "rolled_back" }],
        [103, "source", "run.created", { id: "later-rewind", status: "completed" }],
        [104, "fork", "thread.created", {}],
        [105, "source", "run.updated", { id: "later-rewind", status: "rolled_back" }],
        [106, "source", "run.updated", { id: "pruned-rewind", status: "rolled_back" }],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (${sequence}, ${`event-${sequence}`}, 'thread', ${streamId}, ${sequence}, ${type},
            ${now}, 'server', ${JSON.stringify(payload)}, '{}', 2)
        `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
        VALUES ('event-log-pruned-through', 1, 50, ${now})
      `;
      yield* runMigrations({ toMigrationInclusive: 81 });
      const memberships = yield* sql<{ thread_id: string; fork_run_ids_json: string | null }>`
        SELECT thread_id, fork_run_ids_json FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      assert.deepEqual(memberships, [
        { thread_id: "empty", fork_run_ids_json: "[]" },
        { thread_id: "fork", fork_run_ids_json: '["kept","later-rewind","boundary"]' },
        { thread_id: "root", fork_run_ids_json: null },
      ]);
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'rolled_back'`;
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT thread_id, fork_run_ids_json FROM orchestration_v2_projection_threads ORDER BY thread_id`,
        memberships,
      );
    }),
  );
});
