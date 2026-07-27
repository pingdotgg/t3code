import type * as datasync from "@distilled.cloud/aws/datasync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Task } from "./Task.ts";

/**
 * Runtime binding for `datasync:StartTaskExecution`.
 *
 * Starts a run of the bound {@link Task} — the moment data actually moves.
 * The task ARN is injected from the binding; pass `OverrideOptions`,
 * `Includes`/`Excludes`, or a `ManifestConfig` to shape the individual run.
 * Returns the new execution's ARN for use with `DescribeTaskExecution` /
 * `CancelTaskExecution`. Provide the implementation with
 * `Effect.provide(AWS.DataSync.StartTaskExecutionHttp)`.
 * @binding
 * @section Running Transfers
 * @example Kick Off A Transfer
 * ```typescript
 * // init — bind the operation to the task
 * const startTaskExecution = yield* AWS.DataSync.StartTaskExecution(task);
 *
 * // runtime
 * const { TaskExecutionArn } = yield* startTaskExecution();
 * yield* Effect.log(`transfer started: ${TaskExecutionArn}`);
 * ```
 */
export interface StartTaskExecution extends Binding.Service<
  StartTaskExecution,
  "AWS.DataSync.StartTaskExecution",
  (
    task: Task,
  ) => Effect.Effect<
    (
      request?: Omit<datasync.StartTaskExecutionRequest, "TaskArn">,
    ) => Effect.Effect<
      datasync.StartTaskExecutionResponse,
      datasync.StartTaskExecutionError
    >
  >
> {}
export const StartTaskExecution = Binding.Service<StartTaskExecution>(
  "AWS.DataSync.StartTaskExecution",
);
