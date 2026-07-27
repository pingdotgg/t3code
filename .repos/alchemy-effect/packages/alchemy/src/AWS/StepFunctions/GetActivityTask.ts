import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Activity } from "./Activity.ts";

export interface GetActivityTaskRequest extends Omit<
  sfn.GetActivityTaskInput,
  "activityArn"
> {}

/**
 * Runtime binding for `states:GetActivityTask` — the activity worker's
 * long-poll. Bind this operation to an {@link Activity} inside a function
 * runtime to receive scheduled activity tasks with the activity ARN
 * injected automatically.
 *
 * The call blocks for up to 60 seconds when no task is scheduled (an empty
 * `taskToken` means the poll timed out) — size the host's timeout
 * accordingly. Complete the returned task with `SendTaskSuccess` /
 * `SendTaskFailure`, keeping it alive with `SendTaskHeartbeat`.
 * @binding
 * @section Activity Workers
 * @example Poll for a task and complete it
 * ```typescript
 * const getActivityTask = yield* StepFunctions.GetActivityTask(activity);
 * const sendTaskSuccess = yield* StepFunctions.SendTaskSuccess(activity);
 *
 * const task = yield* getActivityTask({ workerName: "worker-1" });
 * if (task.taskToken) {
 *   yield* sendTaskSuccess({
 *     taskToken: task.taskToken,
 *     output: JSON.stringify({ handled: true }),
 *   });
 * }
 * ```
 */
export interface GetActivityTask extends Binding.Service<
  GetActivityTask,
  "AWS.StepFunctions.GetActivityTask",
  (
    activity: Activity,
  ) => Effect.Effect<
    (
      request?: GetActivityTaskRequest,
    ) => Effect.Effect<sfn.GetActivityTaskOutput, sfn.GetActivityTaskError>
  >
> {}
export const GetActivityTask = Binding.Service<GetActivityTask>(
  "AWS.StepFunctions.GetActivityTask",
);
