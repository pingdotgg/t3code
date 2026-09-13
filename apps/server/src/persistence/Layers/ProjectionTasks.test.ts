import { ProjectId, ProviderInstanceId, TaskId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionTaskRepository, type ProjectionTask } from "../Services/ProjectionTasks.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../Services/ProjectionThreads.ts";
import { ProjectionTaskRepositoryLive } from "./ProjectionTasks.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const timestamp = "2026-09-13T00:00:00.000Z";
const task = (id: string): ProjectionTask => ({
  taskId: TaskId.make(id),
  name: "New task",
  description: null,
  primaryProjectId: ProjectId.make("project-primary"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
});

it.layer(
  Layer.mergeAll(ProjectionTaskRepositoryLive, ProjectionThreadRepositoryLive).pipe(
    Layer.provide(SqlitePersistenceMemory),
  ),
)("ProjectionTaskRepository", (it) => {
  it.effect(
    "round-trips nullable fields, lifecycle state, tombstones and deterministic ordering",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionTaskRepository;
        const original = task("task-roundtrip-b");
        assert.isTrue(Option.isNone(yield* repository.getById({ taskId: original.taskId })));
        yield* repository.upsert(original);
        assert.deepEqual(Option.getOrThrow(yield* repository.getById(original)), original);

        const updated: ProjectionTask = {
          ...original,
          name: "Renamed task",
          description: "Task description",
          primaryProjectId: ProjectId.make("project-reassigned"),
          archivedAt: timestamp,
          settledOverride: "settled",
          settledAt: timestamp,
          unsettledAt: timestamp,
          snoozedUntil: "2026-09-14T00:00:00.000Z",
          snoozedAt: timestamp,
          pinnedAt: timestamp,
          pinOrderKey: "a0",
          activeOrderKey: "b0",
          updatedAt: "2026-09-13T01:00:00.000Z",
          deletedAt: "2026-09-13T01:00:00.000Z",
        };
        yield* repository.upsert(updated);
        const sibling = task("task-roundtrip-a");
        yield* repository.upsert(sibling);
        assert.deepEqual(Option.getOrThrow(yield* repository.getById(original)), updated);
        assert.deepEqual(yield* repository.listAll(), [sibling, updated]);

        yield* repository.upsert({ ...updated, description: null });
        assert.isNull(Option.getOrThrow(yield* repository.getById(original)).description);
        yield* repository.deleteById(original);
        assert.isTrue(Option.isNone(yield* repository.getById(original)));
        yield* repository.deleteById(sibling);
      }),
  );

  it.effect(
    "preserves thread checkout and archived state across membership updates and removal",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadRepository;
        const original: ProjectionThread = {
          threadId: ThreadId.make("thread-membership"),
          projectId: ProjectId.make("project-foreign"),
          title: "Existing thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/member",
          worktreePath: "/tmp/member",
          latestTurnId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: timestamp,
          settledOverride: "settled",
          settledAt: timestamp,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          latestUserMessageAt: null,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
          deletedAt: null,
        };
        yield* repository.upsert(original);
        const initial = Option.getOrThrow(yield* repository.getById(original));
        assert.isNull(initial.taskId);
        const assigned = { ...initial, taskId: TaskId.make("task-membership") };
        yield* repository.upsert(assigned);
        assert.deepEqual(yield* repository.listByProjectId(original), [assigned]);
        const renamed = { ...assigned, title: "Renamed member" };
        yield* repository.upsert(renamed);
        assert.deepEqual(Option.getOrThrow(yield* repository.getById(original)), renamed);
        yield* repository.upsert({ ...renamed, taskId: null });
        assert.deepEqual(Option.getOrThrow(yield* repository.getById(original)), {
          ...renamed,
          taskId: null,
        });
      }),
  );
});
