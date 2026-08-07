import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Activity } from "./Activity.ts";

export interface SendTaskFailureRequest extends sfn.SendTaskFailureInput {}

/**
 * Runtime binding for `states:SendTaskFailure`.
 *
 * Fails a callback-pattern task (`.waitForTaskToken`) or an
 * {@link Activity} task. Bind without arguments for task tokens issued by
 * service-integration Task states, or pass an `Activity` to scope access.
 * @binding
 * @section Callback Pattern
 * @example Fail a waiting task
 * ```typescript
 * const sendTaskFailure = yield* StepFunctions.SendTaskFailure();
 *
 * yield* sendTaskFailure({
 *   taskToken: token,
 *   error: "ApprovalRejected",
 *   cause: "the reviewer rejected the request",
 * });
 * ```
 */
export interface SendTaskFailure extends Binding.Service<
  SendTaskFailure,
  "AWS.StepFunctions.SendTaskFailure",
  (
    activity?: Activity,
  ) => Effect.Effect<
    (
      request: SendTaskFailureRequest,
    ) => Effect.Effect<sfn.SendTaskFailureOutput, sfn.SendTaskFailureError>
  >
> {}
export const SendTaskFailure = Binding.Service<SendTaskFailure>(
  "AWS.StepFunctions.SendTaskFailure",
);
