import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListWorkflowStepExecutions`.
 *
 * Lists the steps of one workflow execution with their runtime status —
 * drill-down from `ListWorkflowExecutions`. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListWorkflowStepExecutionsHttp)`.
 * @binding
 * @section Workflow Monitoring
 * @example List the Steps of a Workflow Execution
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listWorkflowStepExecutions =
 *   yield* AWS.ImageBuilder.ListWorkflowStepExecutions();
 *
 * // runtime
 * const { steps } = yield* listWorkflowStepExecutions({
 *   workflowExecutionId,
 * });
 * ```
 */
export interface ListWorkflowStepExecutions extends Binding.Service<
  ListWorkflowStepExecutions,
  "AWS.ImageBuilder.ListWorkflowStepExecutions",
  () => Effect.Effect<
    (
      request: imagebuilder.ListWorkflowStepExecutionsRequest,
    ) => Effect.Effect<
      imagebuilder.ListWorkflowStepExecutionsResponse,
      imagebuilder.ListWorkflowStepExecutionsError
    >
  >
> {}
export const ListWorkflowStepExecutions =
  Binding.Service<ListWorkflowStepExecutions>(
    "AWS.ImageBuilder.ListWorkflowStepExecutions",
  );
