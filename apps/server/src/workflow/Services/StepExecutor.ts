import type {
  BoardId,
  LaneEntryToken,
  LaneKey,
  PipelineRunId,
  StepKey,
  StepOutcome,
  StepRunId,
  TicketId,
  WorkflowStep,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface StepExecutionContext {
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly pipelineRunId: PipelineRunId;
  readonly stepRunId: StepRunId;
  readonly laneEntryToken: LaneEntryToken;
  readonly laneKey: LaneKey;
  readonly laneStepKeys: ReadonlyArray<StepKey>;
  readonly step: WorkflowStep;
}

export interface StepExecutorShape {
  readonly execute: (ctx: StepExecutionContext) => Effect.Effect<StepOutcome>;
}

export class StepExecutor extends Context.Service<StepExecutor, StepExecutorShape>()(
  "t3/workflow/Services/StepExecutor",
) {}
