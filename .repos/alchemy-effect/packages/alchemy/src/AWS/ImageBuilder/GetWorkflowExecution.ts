import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:GetWorkflowExecution`.
 *
 * Reads the runtime state of one workflow execution (a build/test/distribute
 * workflow run within an image build) — its status, step counts, and
 * timing. Workflow executions are created dynamically by builds, so this is
 * an account-level binding: pass an id from `ListWorkflowExecutions`.
 * Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.GetWorkflowExecutionHttp)`.
 * @binding
 * @section Workflow Monitoring
 * @example Read a Workflow Execution's State
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getWorkflowExecution = yield* AWS.ImageBuilder.GetWorkflowExecution();
 *
 * // runtime
 * const execution = yield* getWorkflowExecution({ workflowExecutionId });
 * yield* Effect.log(`${execution.type} workflow is ${execution.status}`);
 * ```
 */
export interface GetWorkflowExecution extends Binding.Service<
  GetWorkflowExecution,
  "AWS.ImageBuilder.GetWorkflowExecution",
  () => Effect.Effect<
    (
      request: imagebuilder.GetWorkflowExecutionRequest,
    ) => Effect.Effect<
      imagebuilder.GetWorkflowExecutionResponse,
      imagebuilder.GetWorkflowExecutionError
    >
  >
> {}
export const GetWorkflowExecution = Binding.Service<GetWorkflowExecution>(
  "AWS.ImageBuilder.GetWorkflowExecution",
);
