import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkflowTerminalRetentionSweepResult {
  readonly candidateCount: number;
  readonly deletedCount: number;
  readonly failedCount: number;
}

export interface WorkflowTerminalRetentionSweeperShape {
  readonly sweep: () => Effect.Effect<WorkflowTerminalRetentionSweepResult>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkflowTerminalRetentionSweeper extends Context.Service<
  WorkflowTerminalRetentionSweeper,
  WorkflowTerminalRetentionSweeperShape
>()("t3/workflow/Services/WorkflowTerminalRetentionSweeper") {}
