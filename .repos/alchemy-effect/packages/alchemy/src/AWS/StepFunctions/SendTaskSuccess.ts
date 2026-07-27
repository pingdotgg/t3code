import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Activity } from "./Activity.ts";

export interface SendTaskSuccessRequest extends sfn.SendTaskSuccessInput {}

/**
 * Runtime binding for `states:SendTaskSuccess`.
 *
 * Completes a callback-pattern task (`.waitForTaskToken`) or an
 * {@link Activity} task successfully. Bind without arguments for task
 * tokens issued by service-integration Task states (IAM cannot scope
 * those), or pass an `Activity` to scope access to its tasks.
 * @binding
 * @section Callback Pattern
 * @example Complete a waiting task
 * ```typescript
 * const sendTaskSuccess = yield* StepFunctions.SendTaskSuccess();
 *
 * yield* sendTaskSuccess({
 *   taskToken: token,
 *   output: JSON.stringify({ approved: true }),
 * });
 * ```
 */
export interface SendTaskSuccess extends Binding.Service<
  SendTaskSuccess,
  "AWS.StepFunctions.SendTaskSuccess",
  (
    activity?: Activity,
  ) => Effect.Effect<
    (
      request: SendTaskSuccessRequest,
    ) => Effect.Effect<sfn.SendTaskSuccessOutput, sfn.SendTaskSuccessError>
  >
> {}
export const SendTaskSuccess = Binding.Service<SendTaskSuccess>(
  "AWS.StepFunctions.SendTaskSuccess",
);
