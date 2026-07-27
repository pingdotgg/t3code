import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface StartPipelineExecutionRequest extends Omit<
  SVC.StartPipelineExecutionInput,
  "name"
> {}

/**
 * Runtime binding for `codepipeline:StartPipelineExecution` — lets a
 * workload kick off an execution of a pipeline (optionally overriding
 * pipeline variables or source revisions).
 *
 * The response carries the `pipelineExecutionId`, which can be observed with
 * the {@link GetPipelineExecution} binding.
 * @binding
 * @section Running Pipelines
 * @example Start an Execution
 * ```typescript
 * const startExecution = yield* AWS.CodePipeline.StartPipelineExecution(pipeline);
 *
 * const { pipelineExecutionId } = yield* startExecution({
 *   variables: [{ name: "ENV", value: "prod" }],
 * });
 * ```
 */
export interface StartPipelineExecution extends Binding.Service<
  StartPipelineExecution,
  "AWS.CodePipeline.StartPipelineExecution",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request?: StartPipelineExecutionRequest,
    ) => Effect.Effect<
      SVC.StartPipelineExecutionOutput,
      SVC.StartPipelineExecutionError
    >
  >
> {}
export const StartPipelineExecution = Binding.Service<StartPipelineExecution>(
  "AWS.CodePipeline.StartPipelineExecution",
);
