import type * as datasync from "@distilled.cloud/aws/datasync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Task } from "./Task.ts";

/**
 * Runtime binding for `datasync:DescribeTaskExecution`.
 *
 * Reads one execution of the bound {@link Task} — status, bytes/files
 * transferred, per-phase results — to monitor an ongoing transfer or check
 * a finished one. Address the execution with the ARN returned by
 * `StartTaskExecution`; access is granted on the bound task's executions.
 * Provide the implementation with
 * `Effect.provide(AWS.DataSync.DescribeTaskExecutionHttp)`.
 * @binding
 * @section Running Transfers
 * @example Watch A Transfer's Progress
 * ```typescript
 * // init — bind the operation to the task
 * const describeTaskExecution = yield* AWS.DataSync.DescribeTaskExecution(task);
 *
 * // runtime
 * const execution = yield* describeTaskExecution({
 *   TaskExecutionArn: executionArn,
 * });
 * yield* Effect.log(`${execution.Status}: ${execution.BytesTransferred} bytes`);
 * ```
 */
export interface DescribeTaskExecution extends Binding.Service<
  DescribeTaskExecution,
  "AWS.DataSync.DescribeTaskExecution",
  (
    task: Task,
  ) => Effect.Effect<
    (
      request: datasync.DescribeTaskExecutionRequest,
    ) => Effect.Effect<
      datasync.DescribeTaskExecutionResponse,
      datasync.DescribeTaskExecutionError
    >
  >
> {}
export const DescribeTaskExecution = Binding.Service<DescribeTaskExecution>(
  "AWS.DataSync.DescribeTaskExecution",
);
