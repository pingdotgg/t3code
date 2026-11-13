import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("089_ForkHistoryMembership", (it) => {
  it.effect("preserves historical boundary runs when earlier lifecycle evidence was pruned", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });
      const forkedAt = "2026-11-10T12:02:00.000Z";
      const rewoundAt = "2026-11-10T12:03:00.000Z";
      for (const [id, status, ordinal] of [
        ["kept", "completed", 1],
        ["boundary", "rolled_back", 2],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
          ) VALUES (${id}, 'source', ${ordinal}, 'codex', ${status}, ${forkedAt}, ${rewoundAt}, '{}')
        `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES ('fork', 'project', 'fork', 'codex', 'full-access', 'default', ${forkedAt}, ${forkedAt},
          '{"forkedFrom":{"type":"run","threadId":"source","runId":"boundary"}}')
      `;
      for (const [sequence, streamId, type, payload] of [
        [100, "fork", "thread.created", {}],
        [200, "source", "run.updated", { id: "boundary", status: "rolled_back" }],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (${sequence}, ${`event-${sequence}`}, 'thread', ${streamId}, ${sequence}, ${type},
            ${rewoundAt}, 'server', ${JSON.stringify(payload)}, '{}', 2)
        `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at)
        VALUES ('event-log-pruned-through', 1, 150, ${rewoundAt})
      `;
      const fallback = () => sql<{ run_id: string }>`
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE ordinal <= 2
          AND NOT COALESCE(status = 'rolled_back' AND julianday(completed_at) < julianday(${forkedAt}), 0)
        ORDER BY ordinal
      `;
      assert.deepEqual(yield* fallback(), [{ run_id: "kept" }, { run_id: "boundary" }]);
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT fork_run_ids_json FROM orchestration_v2_projection_threads`,
        [{ fork_run_ids_json: null }],
      );
      assert.deepEqual(yield* fallback(), [{ run_id: "kept" }, { run_id: "boundary" }]);
    }),
  );
});
