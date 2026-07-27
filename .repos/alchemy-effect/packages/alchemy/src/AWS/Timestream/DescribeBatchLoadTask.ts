import type * as TSW from "@distilled.cloud/aws/timestream-write";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeBatchLoadTaskRequest
  extends TSW.DescribeBatchLoadTaskRequest {}

/**
 * Runtime binding for `timestream-write:DescribeBatchLoadTask` — poll a bulk
 * import started by {@link CreateBatchLoadTask} for its status and progress
 * report.
 *
 * Batch-load task reads are keyed by `TaskId` and authorized account-wide, so
 * this is an account-level binding invoked with no resource argument.
 *
 * Provide `Timestream.DescribeBatchLoadTaskHttp` on the Function to implement
 * the binding.
 *
 * @binding
 * @section Batch Loading
 * @example Poll an import until it finishes
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeBatchLoadTask = yield* Timestream.DescribeBatchLoadTask();
 *
 * // runtime
 * const described = yield* describeBatchLoadTask({ TaskId: task.TaskId });
 * // described.BatchLoadTaskDescription?.TaskStatus === "SUCCEEDED"
 * ```
 */
export interface DescribeBatchLoadTask extends Binding.Service<
  DescribeBatchLoadTask,
  "AWS.Timestream.DescribeBatchLoadTask",
  () => Effect.Effect<
    (
      request: DescribeBatchLoadTaskRequest,
    ) => Effect.Effect<
      TSW.DescribeBatchLoadTaskResponse,
      TSW.DescribeBatchLoadTaskError | TSW.DescribeEndpointsError
    >
  >
> {}

export const DescribeBatchLoadTask = Binding.Service<DescribeBatchLoadTask>(
  "AWS.Timestream.DescribeBatchLoadTask",
);
