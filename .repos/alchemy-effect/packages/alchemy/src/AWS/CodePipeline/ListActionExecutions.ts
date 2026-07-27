import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface ListActionExecutionsRequest extends Omit<
  SVC.ListActionExecutionsInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:ListActionExecutions` — enumerates the
 * action-level execution history of the pipeline, optionally filtered to a
 * single execution.
 * @binding
 * @section Observing Pipelines
 * @example List Action Executions For One Run
 * ```typescript
 * const listActions = yield* AWS.CodePipeline.ListActionExecutions(pipeline);
 *
 * const { actionExecutionDetails } = yield* listActions({
 *   filter: { pipelineExecutionId: executionId },
 * });
 * ```
 */
export interface ListActionExecutions extends Binding.Service<
  ListActionExecutions,
  "AWS.CodePipeline.ListActionExecutions",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request?: ListActionExecutionsRequest,
    ) => Effect.Effect<
      SVC.ListActionExecutionsOutput,
      SVC.ListActionExecutionsError
    >
  >
> {}
export const ListActionExecutions = Binding.Service<ListActionExecutions>(
  "AWS.CodePipeline.ListActionExecutions",
);
