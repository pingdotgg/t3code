import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface ListPipelineExecutionsRequest extends Omit<
  SVC.ListPipelineExecutionsInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:ListPipelineExecutions` — enumerates
 * recent executions of the pipeline (newest first).
 * @binding
 * @section Observing Pipelines
 * @example List Recent Executions
 * ```typescript
 * const listExecutions = yield* AWS.CodePipeline.ListPipelineExecutions(pipeline);
 *
 * const { pipelineExecutionSummaries } = yield* listExecutions({
 *   maxResults: 10,
 * });
 * ```
 */
export interface ListPipelineExecutions extends Binding.Service<
  ListPipelineExecutions,
  "AWS.CodePipeline.ListPipelineExecutions",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request?: ListPipelineExecutionsRequest,
    ) => Effect.Effect<
      SVC.ListPipelineExecutionsOutput,
      SVC.ListPipelineExecutionsError
    >
  >
> {}
export const ListPipelineExecutions = Binding.Service<ListPipelineExecutions>(
  "AWS.CodePipeline.ListPipelineExecutions",
);
