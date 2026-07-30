import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface RetryStageExecutionRequest extends Omit<
  SVC.RetryStageExecutionInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:RetryStageExecution` — re-runs a failed
 * stage, either just the failed actions (`FAILED_ACTIONS`) or the whole
 * stage from its first action (`ALL_ACTIONS`).
 * @binding
 * @section Operating Stages
 * @example Retry the Failed Actions of a Stage
 * ```typescript
 * const retryStage = yield* AWS.CodePipeline.RetryStageExecution(pipeline);
 *
 * yield* retryStage({
 *   stageName: "Deploy",
 *   pipelineExecutionId: executionId,
 *   retryMode: "FAILED_ACTIONS",
 * });
 * ```
 */
export interface RetryStageExecution extends Binding.Service<
  RetryStageExecution,
  "AWS.CodePipeline.RetryStageExecution",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: RetryStageExecutionRequest,
    ) => Effect.Effect<
      SVC.RetryStageExecutionOutput,
      SVC.RetryStageExecutionError
    >
  >
> {}
export const RetryStageExecution = Binding.Service<RetryStageExecution>(
  "AWS.CodePipeline.RetryStageExecution",
);
