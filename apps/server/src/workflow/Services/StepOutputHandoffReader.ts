import type { LaneKey, PipelineRunId, StepKey, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

/**
 * Reads a prior step's captured output for inter-agent handoff
 * (`{{prev.output}}` / `{{step.<key>.output}}`). Unlike
 * `CapturedStepOutputReader` — which reads by exact `{stepRunId, threadId,
 * turnId}` — this answers "the latest output for a step key", joining
 * `projection_step_run ⋈ projection_pipeline_run` so it can resolve the right
 * pass across loops.
 */
export interface StepOutputHandoffReaderShape {
  /**
   * The newest `completed` step output (parsed `output_json`) for `stepKey`
   * within `(ticketId, laneKey)` across all pipeline runs, ordered by
   * `finished_at DESC` — loop-aware. `null` when no completed output exists.
   */
  readonly latestCompletedOutput: (
    ticketId: TicketId,
    laneKey: LaneKey,
    stepKey: StepKey,
  ) => Effect.Effect<unknown, WorkflowEventStoreError>;
  /**
   * This pass's output for `stepKey` — the `completed` output captured in the
   * given `pipelineRunId`. `null` when this run has no completed output for the
   * step (e.g. a forward reference that hasn't run yet this pass).
   */
  readonly currentPassOutput: (
    pipelineRunId: PipelineRunId,
    stepKey: StepKey,
  ) => Effect.Effect<unknown, WorkflowEventStoreError>;
}

export class StepOutputHandoffReader extends Context.Service<
  StepOutputHandoffReader,
  StepOutputHandoffReaderShape
>()("t3/workflow/Services/StepOutputHandoffReader") {}
