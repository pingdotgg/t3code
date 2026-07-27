import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetRunTaskRequest extends omics.GetRunTaskRequest {}

/**
 * Runtime binding for `omics:GetRunTask`.
 *
 * An account-level run-control operation (no resource argument) that reads the status of a single task within a run.
 * Provide the implementation with `Effect.provide(AWS.Omics.GetRunTaskHttp)`.
 * @binding
 * @section Runs
 * @example Call GetRunTask
 * ```typescript
 * // init — account-level binding takes no resource
 * const getRunTask = yield* AWS.Omics.GetRunTask();
 * // runtime
 * const result = yield* getRunTask({ id: runId });
 * ```
 */
export interface GetRunTask extends Binding.Service<
  GetRunTask,
  "AWS.Omics.GetRunTask",
  () => Effect.Effect<
    (
      request?: GetRunTaskRequest,
    ) => Effect.Effect<omics.GetRunTaskResponse, omics.GetRunTaskError>
  >
> {}

export const GetRunTask = Binding.Service<GetRunTask>("AWS.Omics.GetRunTask");
