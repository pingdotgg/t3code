import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_CanonicalizeLegacyReviewRuntimeMode", (it) => {
  it.effect("promotes legacy review sessions and events to full access", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          runtime_mode,
          pending_approval_count,
          created_at,
          updated_at
        )
        VALUES (
          'review-thread',
          'project-review',
          'Repository review: legacy project',
          'automated-review',
          1,
          '2026-08-10T00:00:00.000Z',
          '2026-08-10T00:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          created_at
        )
        VALUES
          (
            'legacy-review-approval',
            'review-thread',
            NULL,
            'pending',
            '2026-08-10T00:00:00.000Z'
          ),
          (
            'ordinary-thread-approval',
            'ordinary-thread',
            NULL,
            'pending',
            '2026-08-10T00:00:00.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          runtime_mode,
          updated_at
        )
        VALUES (
          'review-thread',
          'running',
          'automated-review',
          '2026-08-10T00:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at
        )
        VALUES (
          'review-thread',
          'codex',
          'codex',
          'automated-review',
          'running',
          '2026-08-10T00:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-review-created',
            'thread',
            'review-thread',
            1,
            'thread.created',
            '2026-08-10T00:00:00.000Z',
            'system',
            '{"threadId":"review-thread","runtimeMode":"automated-review"}',
            '{}'
          ),
          (
            'event-review-session',
            'thread',
            'review-thread',
            2,
            'thread.session-set',
            '2026-08-10T00:00:01.000Z',
            'system',
            '{"threadId":"review-thread","session":{"runtimeMode":"automated-review"}}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const rows = yield* sql<{
        readonly threadRuntimeMode: string;
        readonly sessionRuntimeMode: string;
        readonly providerRuntimeMode: string;
        readonly pendingApprovalCount: number;
        readonly createdEventRuntimeMode: string | null;
        readonly sessionEventRuntimeMode: string | null;
      }>`
        SELECT
          threads.runtime_mode AS "threadRuntimeMode",
          sessions.runtime_mode AS "sessionRuntimeMode",
          provider.runtime_mode AS "providerRuntimeMode",
          threads.pending_approval_count AS "pendingApprovalCount",
          json_extract(created.payload_json, '$.runtimeMode') AS "createdEventRuntimeMode",
          json_extract(session_event.payload_json, '$.session.runtimeMode') AS "sessionEventRuntimeMode"
        FROM projection_threads AS threads
        INNER JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        INNER JOIN provider_session_runtime AS provider
          ON provider.thread_id = threads.thread_id
        INNER JOIN orchestration_events AS created
          ON created.event_id = 'event-review-created'
        INNER JOIN orchestration_events AS session_event
          ON session_event.event_id = 'event-review-session'
        WHERE threads.thread_id = 'review-thread'
      `;

      assert.deepStrictEqual(rows, [
        {
          pendingApprovalCount: 0,
          threadRuntimeMode: "full-access",
          sessionRuntimeMode: "full-access",
          providerRuntimeMode: "full-access",
          createdEventRuntimeMode: "full-access",
          sessionEventRuntimeMode: "full-access",
        },
      ]);

      const pendingApprovals = yield* sql<{ readonly requestId: string }>`
        SELECT request_id AS "requestId"
        FROM projection_pending_approvals
        ORDER BY request_id ASC
      `;
      assert.deepStrictEqual(pendingApprovals, [{ requestId: "ordinary-thread-approval" }]);
    }),
  );
});
