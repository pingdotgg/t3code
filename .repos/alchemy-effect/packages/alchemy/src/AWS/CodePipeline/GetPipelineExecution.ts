import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface GetPipelineExecutionRequest extends Omit<
  SVC.GetPipelineExecutionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:GetPipelineExecution` — returns the
 * status, source revisions, and trigger of one execution.
 * @binding
 * @section Observing Pipelines
 * @example Get an Execution
 * ```typescript
 * const getExecution = yield* AWS.CodePipeline.GetPipelineExecution(pipeline);
 *
 * const { pipelineExecution } = yield* getExecution({
 *   pipelineExecutionId: executionId,
 * });
 * ```
 */
export interface GetPipelineExecution extends Binding.Service<
  GetPipelineExecution,
  "AWS.CodePipeline.GetPipelineExecution",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: GetPipelineExecutionRequest,
    ) => Effect.Effect<
      SVC.GetPipelineExecutionOutput,
      SVC.GetPipelineExecutionError
    >
  >
> {}
export const GetPipelineExecution = Binding.Service<GetPipelineExecution>(
  "AWS.CodePipeline.GetPipelineExecution",
);
