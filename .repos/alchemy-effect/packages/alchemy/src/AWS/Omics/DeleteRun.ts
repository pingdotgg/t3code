import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DeleteRunRequest extends omics.DeleteRunRequest {}

/**
 * Runtime binding for `omics:DeleteRun`.
 *
 * An account-level run-control operation (no resource argument) that deletes a completed run.
 * Provide the implementation with `Effect.provide(AWS.Omics.DeleteRunHttp)`.
 * @binding
 * @section Runs
 * @example Call DeleteRun
 * ```typescript
 * // init — account-level binding takes no resource
 * const deleteRun = yield* AWS.Omics.DeleteRun();
 * // runtime
 * const result = yield* deleteRun({ id: runId });
 * ```
 */
export interface DeleteRun extends Binding.Service<
  DeleteRun,
  "AWS.Omics.DeleteRun",
  () => Effect.Effect<
    (
      request?: DeleteRunRequest,
    ) => Effect.Effect<omics.DeleteRunResponse, omics.DeleteRunError>
  >
> {}

export const DeleteRun = Binding.Service<DeleteRun>("AWS.Omics.DeleteRun");
