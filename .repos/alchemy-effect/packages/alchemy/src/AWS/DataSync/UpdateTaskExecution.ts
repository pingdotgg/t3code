import type * as datasync from "@distilled.cloud/aws/datasync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Task } from "./Task.ts";

/**
 * Runtime binding for `datasync:UpdateTaskExecution`.
 *
 * Modifies an in-flight execution of the bound {@link Task}. The only
 * mutable option is `BytesPerSecond` — throttle (or unthrottle with `-1`) a
 * running transfer without cancelling it. The execution must be launching,
 * preparing, transferring, or verifying. Address it with the ARN returned
 * by `StartTaskExecution`; access is granted on the bound task's
 * executions. Provide the implementation with
 * `Effect.provide(AWS.DataSync.UpdateTaskExecutionHttp)`.
 * @binding
 * @section Running Transfers
 * @example Throttle A Running Transfer
 * ```typescript
 * // init — bind the operation to the task
 * const updateTaskExecution = yield* AWS.DataSync.UpdateTaskExecution(task);
 *
 * // runtime — cap the transfer at 1 MiB/s
 * yield* updateTaskExecution({
 *   TaskExecutionArn: executionArn,
 *   Options: { BytesPerSecond: 1024 * 1024 },
 * });
 * ```
 */
export interface UpdateTaskExecution extends Binding.Service<
  UpdateTaskExecution,
  "AWS.DataSync.UpdateTaskExecution",
  (
    task: Task,
  ) => Effect.Effect<
    (
      request: datasync.UpdateTaskExecutionRequest,
    ) => Effect.Effect<
      datasync.UpdateTaskExecutionResponse,
      datasync.UpdateTaskExecutionError
    >
  >
> {}
export const UpdateTaskExecution = Binding.Service<UpdateTaskExecution>(
  "AWS.DataSync.UpdateTaskExecution",
);
