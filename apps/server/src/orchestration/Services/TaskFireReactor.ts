import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface TaskFireReactorShape {
  /**
   * Start consuming task.fired events within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Wait until every enqueued task.fired event has been processed.
   */
  readonly drain: Effect.Effect<void>;
}

export class TaskFireReactor extends Context.Service<TaskFireReactor, TaskFireReactorShape>()(
  "t3/orchestration/Services/TaskFireReactor",
) {}
