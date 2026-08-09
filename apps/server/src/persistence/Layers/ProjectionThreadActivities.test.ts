import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("normalizes malformed optional task fields without reviving stale liveness", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const threads = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-malformed-task-liveness");

      yield* threads.upsert({
        threadId,
        projectId: ProjectId.make("project-malformed-task-liveness"),
        title: "Malformed task liveness",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:02.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      yield* activities.upsert({
        activityId: EventId.make("activity-valid-task-start"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.started",
        summary: "Task started",
        payload: {
          taskId: "task-malformed-liveness",
          taskType: "local_agent",
          status: "running",
          agentId: "worker-1",
        },
        sequence: 1,
        createdAt: "2026-08-09T00:00:01.000Z",
      });

      yield* activities.upsert({
        activityId: EventId.make("activity-malformed-task-completion"),
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.completed",
        summary: "Task completed",
        payload: {
          taskId: "task-malformed-liveness",
          taskType: 7,
          status: false,
          agentId: { stale: true },
        },
        sequence: 2,
        createdAt: "2026-08-09T00:00:02.000Z",
      });

      const rows = yield* activities.listLatestTaskLiveness();

      assert.deepStrictEqual(rows, [
        {
          threadId,
          taskId: "task-malformed-liveness",
          taskType: null,
          status: null,
          agentId: null,
          kind: "task.completed",
        },
      ]);
    }),
  );
});
