import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transfer:SendWorkflowStepState`.
 *
 * Reports a custom workflow step's outcome back to Transfer Family. A
 * managed workflow's custom step invokes a Lambda with the workflow id,
 * execution id, and a callback token; the Lambda MUST call this operation
 * with `SUCCESS` or `FAILURE` or the step hangs until its timeout. The
 * action authorizes on the workflow's own ARN, which arrives at runtime
 * inside the step event, so the grant is on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.Transfer.SendWorkflowStepStateHttp)`.
 * @binding
 * @section Custom Workflow Steps
 * @example Complete a Custom Step
 * ```typescript
 * // init — account-level binding, no resource argument
 * const sendWorkflowStepState = yield* AWS.Transfer.SendWorkflowStepState();
 *
 * // runtime — inside the Lambda invoked by the workflow's custom step
 * yield* sendWorkflowStepState({
 *   WorkflowId: event.serviceMetadata.executionDetails.workflowId,
 *   ExecutionId: event.serviceMetadata.executionDetails.executionId,
 *   Token: event.token,
 *   Status: "SUCCESS",
 * });
 * ```
 */
export interface SendWorkflowStepState extends Binding.Service<
  SendWorkflowStepState,
  "AWS.Transfer.SendWorkflowStepState",
  () => Effect.Effect<
    (
      request: transfer.SendWorkflowStepStateRequest,
    ) => Effect.Effect<
      transfer.SendWorkflowStepStateResponse,
      transfer.SendWorkflowStepStateError
    >
  >
> {}
export const SendWorkflowStepState = Binding.Service<SendWorkflowStepState>(
  "AWS.Transfer.SendWorkflowStepState",
);
