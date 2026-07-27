import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CancelDataRepositoryTask` operation (IAM action
 * `fsx:CancelDataRepositoryTask` on `*` — runtime-created tasks have ARNs
 * unknowable at deploy time).
 *
 * Cancels a `PENDING` or `EXECUTING` Lustre data repository task started
 * with {@link CreateDataRepositoryTask}. A task that already finished
 * surfaces the typed `DataRepositoryTaskEnded`. Provide the implementation
 * with `Effect.provide(AWS.FSx.CancelDataRepositoryTaskHttp)`.
 * @binding
 * @section Data Repository Tasks
 * @example Cancel a runaway export
 * ```typescript
 * const cancelDataRepositoryTask =
 *   yield* AWS.FSx.CancelDataRepositoryTask();
 *
 * yield* cancelDataRepositoryTask({ TaskId: taskId }).pipe(
 *   Effect.catchTag("DataRepositoryTaskEnded", () => Effect.void),
 * );
 * ```
 */
export interface CancelDataRepositoryTask extends Binding.Service<
  CancelDataRepositoryTask,
  "AWS.FSx.CancelDataRepositoryTask",
  () => Effect.Effect<
    (
      request: fsx.CancelDataRepositoryTaskRequest,
    ) => Effect.Effect<
      fsx.CancelDataRepositoryTaskResponse,
      fsx.CancelDataRepositoryTaskError
    >
  >
> {}
export const CancelDataRepositoryTask =
  Binding.Service<CancelDataRepositoryTask>("AWS.FSx.CancelDataRepositoryTask");
