import { CommandId, type TaskId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TaskScheduler, type TaskSchedulerShape } from "../Services/TaskScheduler.ts";
import { forkParked } from "../../serverActivation.ts";

const DEFAULT_TICK_INTERVAL_MS = 15 * 1000;

export interface TaskSchedulerLiveOptions {
  readonly tickIntervalMs?: number;
}

// Fires are idempotent per due slot: the deterministic commandId collapses a
// crash-retry into the engine's existing command receipt instead of
// double-starting a turn.
const fireCommandId = (taskId: TaskId, nextFireAt: string): CommandId =>
  CommandId.make(`server:task-fire:${taskId}:${nextFireAt}`);

const makeTaskScheduler = (options?: TaskSchedulerLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const tickIntervalMs = Math.max(1, options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);

    const tickEffect: TaskSchedulerShape["tick"] = Effect.fn("TaskScheduler.tick")(function* () {
      // ISO strings compare lexicographically, but the query uses SQLite
      // string comparison on next_fire_at — pass the same normalized format
      // the projector writes.
      const nowIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // A failed due-scan must not kill the loop: log and retry next tick.
      const dueTasks = yield* projectionSnapshotQuery
        .listDueTasks(nowIso)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("task.scheduler.due-scan-failed", { cause }).pipe(Effect.as([])),
          ),
        );

      let dispatchedCount = 0;
      for (const task of dueTasks) {
        if (task.nextFireAt === null) {
          continue;
        }
        yield* orchestrationEngine
          .dispatch({
            type: "task.fire",
            commandId: fireCommandId(task.taskId, task.nextFireAt),
            taskId: task.taskId,
            dueAt: nowIso,
          })
          .pipe(
            Effect.tap(() => {
              dispatchedCount += 1;
              return Effect.logDebug("task.scheduler.fired", {
                taskId: task.taskId,
                threadId: task.threadId,
                nextFireAt: task.nextFireAt,
              });
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning("task.scheduler.fire-failed", {
                taskId: task.taskId,
                cause,
              }),
            ),
          );
      }

      if (dispatchedCount > 0) {
        yield* Effect.logInfo("task.scheduler.tick-complete", {
          dueCount: dueTasks.length,
          dispatchedCount,
        });
      }
      return dispatchedCount;
    });

    const start: TaskSchedulerShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          tickEffect().pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("task.scheduler.tick-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(tickIntervalMs))),
          ),
        );

        yield* Effect.logInfo("task.scheduler.started", {
          tickIntervalMs,
        });
      });

    return {
      start,
      tick: tickEffect,
    } satisfies TaskSchedulerShape;
  });

export const makeTaskSchedulerLive = (options?: TaskSchedulerLiveOptions) =>
  Layer.effect(TaskScheduler, makeTaskScheduler(options));

export const TaskSchedulerLive = makeTaskSchedulerLive();
