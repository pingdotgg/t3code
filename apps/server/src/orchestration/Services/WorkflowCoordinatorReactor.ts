import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * Reconciles durable workflow runs with their scoped worker threads.
 *
 * The coordinator deliberately owns only orchestration transitions. Provider
 * execution continues through the normal thread-turn reactor.
 */
export interface WorkflowCoordinatorReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class WorkflowCoordinatorReactor extends Context.Service<
  WorkflowCoordinatorReactor,
  WorkflowCoordinatorReactorShape
>()("t3/orchestration/Services/WorkflowCoordinatorReactor") {}
