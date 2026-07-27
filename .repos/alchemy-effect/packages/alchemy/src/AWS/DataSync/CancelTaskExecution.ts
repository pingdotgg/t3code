import type * as datasync from "@distilled.cloud/aws/datasync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Task } from "./Task.ts";

/**
 * Runtime binding for `datasync:CancelTaskExecution`.
 *
 * Stops a queued or in-flight execution of the bound {@link Task} — e.g. a
 * kill switch when a transfer was started by mistake or is saturating a
 * link. Address the execution with the ARN returned by
 * `StartTaskExecution`; access is granted on the bound task's executions.
 * Provide the implementation with
 * `Effect.provide(AWS.DataSync.CancelTaskExecutionHttp)`.
 * @binding
 * @section Running Transfers
 * @example Cancel A Transfer
 * ```typescript
 * // init — bind the operation to the task
 * const cancelTaskExecution = yield* AWS.DataSync.CancelTaskExecution(task);
 *
 * // runtime
 * yield* cancelTaskExecution({ TaskExecutionArn: executionArn });
 * ```
 */
export interface CancelTaskExecution extends Binding.Service<
  CancelTaskExecution,
  "AWS.DataSync.CancelTaskExecution",
  (
    task: Task,
  ) => Effect.Effect<
    (
      request: datasync.CancelTaskExecutionRequest,
    ) => Effect.Effect<
      datasync.CancelTaskExecutionResponse,
      datasync.CancelTaskExecutionError
    >
  >
> {}
export const CancelTaskExecution = Binding.Service<CancelTaskExecution>(
  "AWS.DataSync.CancelTaskExecution",
);
