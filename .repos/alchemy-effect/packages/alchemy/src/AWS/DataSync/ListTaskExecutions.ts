import type * as datasync from "@distilled.cloud/aws/datasync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Task } from "./Task.ts";

/**
 * Runtime binding for `datasync:ListTaskExecutions`.
 *
 * Enumerates the bound {@link Task}'s executions (most recent first) so an
 * ops function can audit run history or find the latest run's ARN. The task
 * ARN is injected from the binding; pass `MaxResults`/`NextToken` to page.
 * Provide the implementation with
 * `Effect.provide(AWS.DataSync.ListTaskExecutionsHttp)`.
 * @binding
 * @section Monitoring Tasks
 * @example List The Task's Runs
 * ```typescript
 * // init — bind the operation to the task
 * const listTaskExecutions = yield* AWS.DataSync.ListTaskExecutions(task);
 *
 * // runtime
 * const { TaskExecutions } = yield* listTaskExecutions();
 * for (const execution of TaskExecutions ?? []) {
 *   yield* Effect.log(`${execution.TaskExecutionArn}: ${execution.Status}`);
 * }
 * ```
 */
export interface ListTaskExecutions extends Binding.Service<
  ListTaskExecutions,
  "AWS.DataSync.ListTaskExecutions",
  (
    task: Task,
  ) => Effect.Effect<
    (
      request?: Omit<datasync.ListTaskExecutionsRequest, "TaskArn">,
    ) => Effect.Effect<
      datasync.ListTaskExecutionsResponse,
      datasync.ListTaskExecutionsError
    >
  >
> {}
export const ListTaskExecutions = Binding.Service<ListTaskExecutions>(
  "AWS.DataSync.ListTaskExecutions",
);
