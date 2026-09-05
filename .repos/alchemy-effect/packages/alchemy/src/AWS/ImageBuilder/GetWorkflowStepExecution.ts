import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:GetWorkflowStepExecution`.
 *
 * Reads the runtime state of one workflow step — its action, status,
 * rollback status, inputs/outputs, and message. Step executions are created
 * dynamically by builds, so this is an account-level binding: pass an id
 * from `ListWorkflowStepExecutions` or `ListWaitingWorkflowSteps`. Provide
 * the implementation with
 * `Effect.provide(AWS.ImageBuilder.GetWorkflowStepExecutionHttp)`.
 * @binding
 * @section Workflow Monitoring
 * @example Read a Workflow Step's State
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getWorkflowStepExecution =
 *   yield* AWS.ImageBuilder.GetWorkflowStepExecution();
 *
 * // runtime
 * const step = yield* getWorkflowStepExecution({ stepExecutionId });
 * yield* Effect.log(`step ${step.name} is ${step.status}`);
 * ```
 */
export interface GetWorkflowStepExecution extends Binding.Service<
  GetWorkflowStepExecution,
  "AWS.ImageBuilder.GetWorkflowStepExecution",
  () => Effect.Effect<
    (
      request: imagebuilder.GetWorkflowStepExecutionRequest,
    ) => Effect.Effect<
      imagebuilder.GetWorkflowStepExecutionResponse,
      imagebuilder.GetWorkflowStepExecutionError
    >
  >
> {}
export const GetWorkflowStepExecution =
  Binding.Service<GetWorkflowStepExecution>(
    "AWS.ImageBuilder.GetWorkflowStepExecution",
  );
