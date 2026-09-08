import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface StopPipelineExecutionRequest extends Omit<
  SVC.StopPipelineExecutionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:StopPipelineExecution` — stops an
 * in-progress execution, either finishing in-flight actions first or
 * abandoning them (`abandon: true`).
 * ### Running Pipelines
 * **Example:** Stop an Execution
 * ```typescript
 * const stopExecution = yield* AWS.CodePipeline.StopPipelineExecution(pipeline);
 *
 * yield* stopExecution({
 *   pipelineExecutionId: executionId,
 *   abandon: true,
 *   reason: "superseded by hotfix",
 * });
 * ```
 *
 * @binding
 */
export interface StopPipelineExecution extends Binding.Service<
  StopPipelineExecution,
  "AWS.CodePipeline.StopPipelineExecution",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: StopPipelineExecutionRequest,
    ) => Effect.Effect<
      SVC.StopPipelineExecutionOutput,
      SVC.StopPipelineExecutionError
    >
  >
> {}
export const StopPipelineExecution = Binding.Service<StopPipelineExecution>(
  "AWS.CodePipeline.StopPipelineExecution",
);
