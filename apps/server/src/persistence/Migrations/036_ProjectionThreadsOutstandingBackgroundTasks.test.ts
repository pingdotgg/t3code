import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionThreadsOutstandingBackgroundTasks", (it) => {
  it.effect("backfills outstanding background tasks behind the session gate", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const insertThread = (threadId: string) =>
        sql`
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
            ${threadId},
            'project-1',
            ${threadId},
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          )
        `;

      const insertSession = (threadId: string, status: string) =>
        sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            runtime_mode,
            active_turn_id,
            last_error,
            updated_at
          )
          VALUES (
            ${threadId},
            ${status},
            'claude',
            NULL,
            NULL,
            'full-access',
            NULL,
            NULL,
            '2026-07-01T00:01:00.000Z'
          )
        `;

      const insertActivity = (input: {
        readonly activityId: string;
        readonly threadId: string;
        readonly kind: string;
        readonly payload: string;
        readonly createdAt: string;
      }) =>
        sql`
          INSERT INTO projection_thread_activities (
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          )
          VALUES (
            ${input.activityId},
            ${input.threadId},
            NULL,
            'info',
            ${input.kind},
            ${input.kind},
            ${input.payload},
            NULL,
            ${input.createdAt}
          )
        `;

      // Live session, two tasks started and the first one finished.
      yield* insertThread("thread-live");
      yield* insertSession("thread-live", "ready");
      yield* insertActivity({
        activityId: "activity-live-1",
        threadId: "thread-live",
        kind: "task.started",
        payload: '{"taskId":"task-1","taskType":"explore"}',
        createdAt: "2026-07-01T00:02:00.000Z",
      });
      yield* insertActivity({
        activityId: "activity-live-2",
        threadId: "thread-live",
        kind: "task.started",
        payload: '{"taskId":"task-2","taskType":"explore"}',
        createdAt: "2026-07-01T00:03:00.000Z",
      });
      yield* insertActivity({
        activityId: "activity-live-3",
        threadId: "thread-live",
        kind: "task.completed",
        payload: '{"taskId":"task-1","status":"completed"}',
        createdAt: "2026-07-01T00:04:00.000Z",
      });

      // Same timeline, but the provider process is gone: its children went
      // with it, so the thread must stay at zero.
      yield* insertThread("thread-dead");
      yield* insertSession("thread-dead", "stopped");
      yield* insertActivity({
        activityId: "activity-dead-1",
        threadId: "thread-dead",
        kind: "task.started",
        payload: '{"taskId":"task-3"}',
        createdAt: "2026-07-01T00:02:00.000Z",
      });

      // Live session, every task settled.
      yield* insertThread("thread-settled");
      yield* insertSession("thread-settled", "running");
      yield* insertActivity({
        activityId: "activity-settled-1",
        threadId: "thread-settled",
        kind: "task.progress",
        payload: '{"taskId":"task-4","detail":"Reading"}',
        createdAt: "2026-07-01T00:02:00.000Z",
      });
      yield* insertActivity({
        activityId: "activity-settled-2",
        threadId: "thread-settled",
        kind: "task.completed",
        payload: '{"taskId":"task-4","status":"stopped"}',
        createdAt: "2026-07-01T00:03:00.000Z",
      });

      // No session row at all: nothing for children to run under.
      yield* insertThread("thread-sessionless");
      yield* insertActivity({
        activityId: "activity-sessionless-1",
        threadId: "thread-sessionless",
        kind: "task.started",
        payload: '{"taskId":"task-5"}',
        createdAt: "2026-07-01T00:02:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly outstandingBackgroundTaskCount: number;
        readonly outstandingBackgroundTaskStartedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          outstanding_background_task_count AS "outstandingBackgroundTaskCount",
          outstanding_background_task_started_at AS "outstandingBackgroundTaskStartedAt"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "thread-dead",
          outstandingBackgroundTaskCount: 0,
          outstandingBackgroundTaskStartedAt: null,
        },
        {
          threadId: "thread-live",
          outstandingBackgroundTaskCount: 1,
          outstandingBackgroundTaskStartedAt: "2026-07-01T00:03:00.000Z",
        },
        {
          threadId: "thread-sessionless",
          outstandingBackgroundTaskCount: 0,
          outstandingBackgroundTaskStartedAt: null,
        },
        {
          threadId: "thread-settled",
          outstandingBackgroundTaskCount: 0,
          outstandingBackgroundTaskStartedAt: null,
        },
      ]);
    }),
  );
});
