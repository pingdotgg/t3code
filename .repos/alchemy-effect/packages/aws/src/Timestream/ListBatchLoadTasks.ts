import type * as TSW from "@distilled.cloud/aws/timestream-write";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

export interface ListBatchLoadTasksRequest extends TSW.ListBatchLoadTasksRequest {}

/**
 * Runtime binding for `timestream-write:ListBatchLoadTasks` — enumerate the
 * account's bulk imports, optionally filtered by status.
 *
 * Account-level binding invoked with no resource argument.
 *
 * Provide `Timestream.ListBatchLoadTasksHttp` on the Function to implement
 * the binding.
 *
 * ### Batch Loading
 * **Example:** List in-progress imports
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listBatchLoadTasks = yield* Timestream.ListBatchLoadTasks();
 *
 * // runtime
 * const tasks = yield* listBatchLoadTasks({ TaskStatus: "IN_PROGRESS" });
 * // tasks.BatchLoadTasks lists each task's TaskId and status
 * ```
 *
 * @binding
 */
export interface ListBatchLoadTasks extends Binding.Service<
  ListBatchLoadTasks,
  "AWS.Timestream.ListBatchLoadTasks",
  () => Effect.Effect<
    (
      request: ListBatchLoadTasksRequest,
    ) => Effect.Effect<
      TSW.ListBatchLoadTasksResponse,
      TSW.ListBatchLoadTasksError | TSW.DescribeEndpointsError
    >
  >
> {}

export const ListBatchLoadTasks = Binding.Service<ListBatchLoadTasks>(
  "AWS.Timestream.ListBatchLoadTasks",
);
