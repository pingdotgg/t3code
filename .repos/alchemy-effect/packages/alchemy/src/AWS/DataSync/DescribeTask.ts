import type * as datasync from "@distilled.cloud/aws/datasync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Task } from "./Task.ts";

/**
 * Runtime binding for `datasync:DescribeTask`.
 *
 * Reads the bound {@link Task}'s full detail — status, transfer options,
 * filters, schedule (including `ScheduleDetails` with the last disable
 * reason), and the ARN of the currently running execution — so an ops
 * function can monitor the task's health. The task ARN is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.DataSync.DescribeTaskHttp)`.
 * @binding
 * @section Monitoring Tasks
 * @example Check The Task's Status
 * ```typescript
 * // init — bind the operation to the task
 * const describeTask = yield* AWS.DataSync.DescribeTask(task);
 *
 * // runtime
 * const detail = yield* describeTask();
 * yield* Effect.log(`task ${detail.Name} is ${detail.Status}`);
 * ```
 */
export interface DescribeTask extends Binding.Service<
  DescribeTask,
  "AWS.DataSync.DescribeTask",
  (
    task: Task,
  ) => Effect.Effect<
    () => Effect.Effect<
      datasync.DescribeTaskResponse,
      datasync.DescribeTaskError
    >
  >
> {}
export const DescribeTask = Binding.Service<DescribeTask>(
  "AWS.DataSync.DescribeTask",
);
