import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadActivityRepositoryLive,
  THREAD_ID_BATCH_SIZE,
} from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'activity-task-unrelated-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'activity-task-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-task-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'activity-task-other', ${threadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("activity-task-untitled"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("activity-task-blank-title"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["activity-task-untitled", "activity-task-blank-title"],
      );

      const activity = yield* repository.getLatestTaskActivity({
        threadId,
        taskId: "task-1",
      });
      assert.equal(activity._tag, "Some");
      if (activity._tag === "Some") {
        assert.equal(activity.value.activityId, EventId.make("activity-task-progress"));
        assert.deepEqual(activity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }

      assert.equal(
        (yield* repository.getLatestTaskActivity({ threadId, taskId: "missing" }))._tag,
        "None",
      );
    }),
  );

  it.effect("reads only task lifecycle rows, scoped to the requested threads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-task-lifecycle-kinds");
      const otherThreadId = ThreadId.make("thread-task-lifecycle-kinds-other");

      // The excluded rows carry unparseable payloads: if the kind filter ever
      // stops running in SQLite, decoding them fails the read outright.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'lifecycle-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","agentKind":"agent"}', 1,
            '2026-03-02T00:00:00.000Z'
          ),
          (
            'lifecycle-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1"}', 2, '2026-03-02T00:00:01.000Z'
          ),
          (
            'lifecycle-updated', ${threadId}, NULL, 'info', 'task.updated',
            'updated', '{"taskId":"task-1","status":"running"}', 3,
            '2026-03-02T00:00:02.000Z'
          ),
          (
            'lifecycle-completed', ${threadId}, NULL, 'info', 'task.completed',
            'completed', '{"taskId":"task-1"}', 4, '2026-03-02T00:00:03.000Z'
          ),
          (
            'lifecycle-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'tool output', 'not-json', 5, '2026-03-02T00:00:04.000Z'
          ),
          (
            'lifecycle-user-input', ${threadId}, NULL, 'info', 'user-input.requested',
            'input requested', 'not-json', 6, '2026-03-02T00:00:05.000Z'
          ),
          (
            'lifecycle-other-thread', ${otherThreadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-2","agentKind":"agent"}', 1,
            '2026-03-02T00:00:06.000Z'
          )
      `;

      const threadRows = yield* repository.listTaskLifecycleByThreadId({ threadId });
      assert.deepEqual(
        threadRows.map((entry) => entry.activityId),
        ["lifecycle-started", "lifecycle-progress", "lifecycle-updated", "lifecycle-completed"],
      );

      const batchedRows = yield* repository.listTaskLifecycleByThreadIds({
        threadIds: [threadId, otherThreadId],
      });
      assert.deepEqual(
        batchedRows.map((entry) => entry.activityId),
        [
          "lifecycle-started",
          "lifecycle-progress",
          "lifecycle-updated",
          "lifecycle-completed",
          "lifecycle-other-thread",
        ],
      );
    }),
  );

  it.effect("orders unsequenced task rows ahead of sequenced ones", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-task-lifecycle-order");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'order-sequenced-second', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1"}', 2, '2026-03-03T00:00:00.000Z'
          ),
          (
            'order-sequenced-first', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1"}', 1, '2026-03-03T00:00:01.000Z'
          ),
          (
            'order-unsequenced-newer', ${threadId}, NULL, 'info', 'task.updated',
            'updated', '{"taskId":"task-1"}', NULL, '2026-03-03T00:00:03.000Z'
          ),
          (
            'order-unsequenced-older', ${threadId}, NULL, 'info', 'task.updated',
            'updated', '{"taskId":"task-1"}', NULL, '2026-03-03T00:00:02.000Z'
          )
      `;

      // Unsequenced rows first, ordered by created_at; sequenced rows after,
      // ordered by sequence even when created_at disagrees.
      const expected = [
        "order-unsequenced-older",
        "order-unsequenced-newer",
        "order-sequenced-first",
        "order-sequenced-second",
      ];
      assert.deepEqual(
        (yield* repository.listTaskLifecycleByThreadId({ threadId })).map(
          (entry) => entry.activityId,
        ),
        expected,
      );
      assert.deepEqual(
        (yield* repository.listTaskLifecycleByThreadIds({ threadIds: [threadId] })).map(
          (entry) => entry.activityId,
        ),
        expected,
      );
    }),
  );

  it.effect("reads every thread when the id list spans more than one query chunk", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;

      // One thread past the chunk boundary, so the batched read has to stitch
      // two statements together. Ids are zero-padded, keeping thread_id order
      // identical to the requested order.
      const threadIds = Array.from({ length: THREAD_ID_BATCH_SIZE + 1 }, (_, index) =>
        ThreadId.make(`thread-task-chunk-${String(index).padStart(4, "0")}`),
      );
      // The threads on either side of the boundary carry two rows each, so a
      // regression that drops rows at the boundary or reorders them inside a
      // thread shows up here.
      const rows = threadIds.flatMap((threadId, index) =>
        Array.from(
          { length: index === THREAD_ID_BATCH_SIZE - 1 || index === THREAD_ID_BATCH_SIZE ? 2 : 1 },
          (_, rowIndex) => ({
            activity_id: `activity-${threadId}-${rowIndex}`,
            thread_id: threadId,
            turn_id: null,
            tone: "info",
            kind: rowIndex === 0 ? "task.started" : "task.completed",
            summary: "chunked",
            payload_json: '{"taskId":"task-1","agentKind":"agent"}',
            sequence: rowIndex + 1,
            created_at: "2026-03-04T00:00:00.000Z",
          }),
        ),
      );
      // Small insert batches keep this fixture under SQLite's parameter limit.
      for (let index = 0; index < rows.length; index += 100) {
        yield* sql`
          INSERT INTO projection_thread_activities ${sql.insert(rows.slice(index, index + 100))}
        `;
      }

      assert.deepEqual(
        (yield* repository.listTaskLifecycleByThreadIds({ threadIds })).map(
          (entry) => entry.activityId,
        ),
        rows.map((row) => row.activity_id),
      );
    }),
  );
});
