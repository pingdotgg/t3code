import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:SendWorkflowStepAction`.
 *
 * Resumes or stops an image build that is paused on a `WaitForAction`
 * workflow step — the approval half of a human/automated gate (find pending
 * steps with `ListWaitingWorkflowSteps`). The idempotency `clientToken` is
 * generated automatically. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.SendWorkflowStepActionHttp)`.
 * @binding
 * @section Workflow Monitoring
 * @example Approve a Waiting Build Step
 * ```typescript
 * // init — account-level binding, no resource argument
 * const sendWorkflowStepAction =
 *   yield* AWS.ImageBuilder.SendWorkflowStepAction();
 *
 * // runtime
 * yield* sendWorkflowStepAction({
 *   stepExecutionId,
 *   imageBuildVersionArn,
 *   action: "RESUME",
 *   reason: "approved by review function",
 * });
 * ```
 */
export interface SendWorkflowStepAction extends Binding.Service<
  SendWorkflowStepAction,
  "AWS.ImageBuilder.SendWorkflowStepAction",
  () => Effect.Effect<
    (
      request: Omit<imagebuilder.SendWorkflowStepActionRequest, "clientToken">,
    ) => Effect.Effect<
      imagebuilder.SendWorkflowStepActionResponse,
      imagebuilder.SendWorkflowStepActionError
    >
  >
> {}
export const SendWorkflowStepAction = Binding.Service<SendWorkflowStepAction>(
  "AWS.ImageBuilder.SendWorkflowStepAction",
);
