import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface TaskSchedulerShape {
  /**
   * Start the background scheduler tick loop within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Run one tick immediately: dispatch `task.fire` for every armed task whose
   * nextFireAt has passed. Returns the number of fires dispatched. Exposed as
   * a deterministic seam for tests — never wait on the wall-clock loop.
   */
  readonly tick: () => Effect.Effect<number, never>;
}

export class TaskScheduler extends Context.Service<TaskScheduler, TaskSchedulerShape>()(
  "t3/orchestration/Services/TaskScheduler",
) {}
