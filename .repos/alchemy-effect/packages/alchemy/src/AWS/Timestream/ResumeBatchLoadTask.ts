import type * as TSW from "@distilled.cloud/aws/timestream-write";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ResumeBatchLoadTaskRequest
  extends TSW.ResumeBatchLoadTaskRequest {}

/**
 * Runtime binding for `timestream-write:ResumeBatchLoadTask` — resume a bulk
 * import that Timestream paused (e.g. after transient S3 or throttling
 * failures).
 *
 * Account-level binding invoked with no resource argument; keyed by `TaskId`.
 *
 * Provide `Timestream.ResumeBatchLoadTaskHttp` on the Function to implement
 * the binding.
 *
 * @binding
 * @section Batch Loading
 * @example Resume a paused import
 * ```typescript
 * // init — account-level binding, no resource argument
 * const resumeBatchLoadTask = yield* Timestream.ResumeBatchLoadTask();
 *
 * // runtime
 * yield* resumeBatchLoadTask({ TaskId: task.TaskId });
 * ```
 */
export interface ResumeBatchLoadTask extends Binding.Service<
  ResumeBatchLoadTask,
  "AWS.Timestream.ResumeBatchLoadTask",
  () => Effect.Effect<
    (
      request: ResumeBatchLoadTaskRequest,
    ) => Effect.Effect<
      TSW.ResumeBatchLoadTaskResponse,
      TSW.ResumeBatchLoadTaskError | TSW.DescribeEndpointsError
    >
  >
> {}

export const ResumeBatchLoadTask = Binding.Service<ResumeBatchLoadTask>(
  "AWS.Timestream.ResumeBatchLoadTask",
);
