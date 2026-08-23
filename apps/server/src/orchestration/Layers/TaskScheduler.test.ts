import { CommandId, ProjectId, TaskId, ThreadId, type OrchestrationTask } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { TaskScheduler } from "../Services/TaskScheduler.ts";
import { makeTaskSchedulerLive } from "./TaskScheduler.ts";

function makeDueTask(input: {
  readonly taskId: string;
  readonly nextFireAt: string;
}): OrchestrationTask {
  return {
    taskId: TaskId.make(input.taskId),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    prompt: "Run the nightly checks",
    schedule: { kind: "interval", everyMs: 60 * 60 * 1000 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastFiredAt: null,
    nextFireAt: input.nextFireAt,
    cancelledAt: null,
  };
}

// Shared harness state: tests run sequentially, so each one resets what is
// due and inspects what got dispatched.
const state = {
  dueTasks: [] as OrchestrationTask[],
  dispatched: [] as Array<{ type: string; commandId: CommandId; dueAt: string }>,
};

const schedulerLayer = makeTaskSchedulerLive({ tickIntervalMs: 60_000 }).pipe(
  Layer.provideMerge(
    Layer.succeed(ProjectionSnapshotQuery, {
      listDueTasks: () => Effect.succeed(state.dueTasks),
    } as unknown as ProjectionSnapshotQueryShape),
  ),
  Layer.provideMerge(
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: { type: string; commandId: CommandId; dueAt?: string }) =>
        Effect.sync(() => {
          state.dispatched.push(command as { type: string; commandId: CommandId; dueAt: string });
          return { sequence: 1 };
        }),
    } as unknown as OrchestrationEngineShape),
  ),
);

it.layer(schedulerLayer.pipe(Layer.provideMerge(NodeServices.layer)))("task scheduler", (it) => {
  it.effect("dispatches a deterministic task.fire per due slot", () =>
    Effect.gen(function* () {
      state.dispatched = [];
      state.dueTasks = [
        makeDueTask({ taskId: "task-a", nextFireAt: "2026-01-01T00:00:00.000Z" }),
        makeDueTask({ taskId: "task-b", nextFireAt: "2026-01-01T00:05:00.000Z" }),
      ];

      const scheduler = yield* TaskScheduler;
      const firedCount = yield* scheduler.tick();

      expect(firedCount).toBe(2);
      expect(state.dispatched).toHaveLength(2);
      // Deterministic ids keyed by the due slot so crash-retries collapse
      // into the engine's idempotent command receipts.
      expect(state.dispatched[0]?.type).toBe("task.fire");
      expect(state.dispatched[0]?.commandId).toBe(
        CommandId.make("server:task-fire:task-a:2026-01-01T00:00:00.000Z"),
      );
      expect(state.dispatched[1]?.commandId).toBe(
        CommandId.make("server:task-fire:task-b:2026-01-01T00:05:00.000Z"),
      );
    }),
  );

  it.effect("returns zero and dispatches nothing when no task is due", () =>
    Effect.gen(function* () {
      state.dispatched = [];
      state.dueTasks = [];

      const scheduler = yield* TaskScheduler;
      const firedCount = yield* scheduler.tick();

      expect(firedCount).toBe(0);
      expect(state.dispatched).toHaveLength(0);
    }),
  );
});
