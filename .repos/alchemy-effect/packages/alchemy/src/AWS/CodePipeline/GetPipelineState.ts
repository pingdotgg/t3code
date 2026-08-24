import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Runtime binding for `codepipeline:GetPipelineState` — returns the current
 * state of every stage and action in the pipeline, including in-flight
 * executions, transition states, and manual-approval tokens.
 * @binding
 * @section Observing Pipelines
 * @example Read the Pipeline State
 * ```typescript
 * const getState = yield* AWS.CodePipeline.GetPipelineState(pipeline);
 *
 * const state = yield* getState();
 * const approval = state.stageStates
 *   ?.find((s) => s.stageName === "Approve")
 *   ?.actionStates?.find((a) => a.actionName === "ManualApproval");
 * ```
 */
export interface GetPipelineState extends Binding.Service<
  GetPipelineState,
  "AWS.CodePipeline.GetPipelineState",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    () => Effect.Effect<SVC.GetPipelineStateOutput, SVC.GetPipelineStateError>
  >
> {}
export const GetPipelineState = Binding.Service<GetPipelineState>(
  "AWS.CodePipeline.GetPipelineState",
);
