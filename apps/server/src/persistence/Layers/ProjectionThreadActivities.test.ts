import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("counts user-input lifecycle state without hydrating unrelated payloads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-pending-user-input-count");
      const createdAt = "2026-03-01T00:00:00.000Z";

      yield* Effect.forEach(
        [
          {
            activityId: EventId.make("activity-input-open"),
            kind: "user-input.requested",
            payload: { requestId: "input-open" },
            createdAt,
          },
          {
            activityId: EventId.make("activity-input-resolved-request"),
            kind: "user-input.requested",
            payload: { requestId: "input-resolved" },
            createdAt: "2026-03-01T00:00:01.000Z",
          },
          {
            activityId: EventId.make("activity-input-resolved"),
            kind: "user-input.resolved",
            payload: { requestId: "input-resolved" },
            createdAt: "2026-03-01T00:00:02.000Z",
          },
          {
            activityId: EventId.make("activity-input-stale-request"),
            kind: "user-input.requested",
            payload: { requestId: "input-stale" },
            createdAt: "2026-03-01T00:00:03.000Z",
          },
          {
            activityId: EventId.make("activity-input-stale-failure"),
            kind: "provider.user-input.respond.failed",
            payload: {
              requestId: "input-stale",
              detail: "Unknown pending Codex user input request",
            },
            createdAt: "2026-03-01T00:00:04.000Z",
          },
        ],
        (activity) =>
          repository.upsert({
            ...activity,
            threadId,
            turnId: null,
            tone: "info",
            summary: activity.kind,
          }),
        { discard: true },
      );

      // A malformed tool payload proves the count query never decodes or
      // JSON-inspects unrelated activity bodies.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES (
          'activity-large-tool', ${threadId}, NULL, 'tool', 'tool.completed',
          'large tool output', 'not-json', NULL, '2026-03-01T00:00:05.000Z'
        )
      `;

      assert.equal(yield* repository.countPendingUserInputs({ threadId }), 1);
    }),
  );
});
