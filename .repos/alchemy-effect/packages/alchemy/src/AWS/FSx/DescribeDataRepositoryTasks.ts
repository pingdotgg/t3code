import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDataRepositoryTasks` operation (IAM
 * action `fsx:DescribeDataRepositoryTasks` on `*`).
 *
 * Lists Lustre data repository tasks — optionally filtered by
 * `file-system-id` or `task-lifecycle`, or by explicit `TaskIds` — from
 * inside a function runtime. Pairs with {@link CreateDataRepositoryTask} to
 * poll an export/import task until it reaches `SUCCEEDED`. Provide the
 * implementation with
 * `Effect.provide(AWS.FSx.DescribeDataRepositoryTasksHttp)`.
 * @binding
 * @section Data Repository Tasks
 * @example Poll a task until it finishes
 * ```typescript
 * const describeDataRepositoryTasks =
 *   yield* AWS.FSx.DescribeDataRepositoryTasks();
 *
 * const response = yield* describeDataRepositoryTasks({
 *   TaskIds: [taskId],
 * });
 * yield* Effect.log(response.DataRepositoryTasks?.[0]?.Lifecycle);
 * ```
 */
export interface DescribeDataRepositoryTasks extends Binding.Service<
  DescribeDataRepositoryTasks,
  "AWS.FSx.DescribeDataRepositoryTasks",
  () => Effect.Effect<
    (
      request?: fsx.DescribeDataRepositoryTasksRequest,
    ) => Effect.Effect<
      fsx.DescribeDataRepositoryTasksResponse,
      fsx.DescribeDataRepositoryTasksError
    >
  >
> {}
export const DescribeDataRepositoryTasks =
  Binding.Service<DescribeDataRepositoryTasks>(
    "AWS.FSx.DescribeDataRepositoryTasks",
  );
