import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkflowBoardNotificationSweepResult {
  readonly claimed: number;
  readonly sent: number;
  readonly superseded: number;
  readonly failed: number;
}

export interface WorkflowBoardNotificationDispatcherShape {
  readonly sweep: () => Effect.Effect<WorkflowBoardNotificationSweepResult>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkflowBoardNotificationDispatcher extends Context.Service<
  WorkflowBoardNotificationDispatcher,
  WorkflowBoardNotificationDispatcherShape
>()("t3/workflow/Services/WorkflowBoardNotificationDispatcher") {}
