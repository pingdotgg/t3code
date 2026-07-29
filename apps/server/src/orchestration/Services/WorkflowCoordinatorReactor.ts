import { Context } from "effect";
import type { Effect, Scope } from "effect";

import type { WorkflowRunId } from "@t3tools/contracts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/**
 * Reconciles durable workflow runs with their scoped worker threads.
 *
 * The coordinator deliberately owns only orchestration transitions. Provider
 * execution continues through the normal thread-turn reactor.
 */
export interface WorkflowCoordinatorReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  /**
   * Reconciles a single run inline so callers that just requested it do not
   * have to wait for the event-stream reconciliation hop.
   */
  readonly drainRun: (
    runId: WorkflowRunId,
  ) => Effect.Effect<void, OrchestrationDispatchError | ProjectionRepositoryError>;
}

export class WorkflowCoordinatorReactor extends Context.Service<
  WorkflowCoordinatorReactor,
  WorkflowCoordinatorReactorShape
>()("t3/orchestration/Services/WorkflowCoordinatorReactor") {}
