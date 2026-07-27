import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetRunRequest extends omics.GetRunRequest {}

/**
 * Runtime binding for `omics:GetRun`.
 *
 * An account-level run-control operation (no resource argument) that reads the status and details of a run.
 * Provide the implementation with `Effect.provide(AWS.Omics.GetRunHttp)`.
 * @binding
 * @section Runs
 * @example Call GetRun
 * ```typescript
 * // init — account-level binding takes no resource
 * const getRun = yield* AWS.Omics.GetRun();
 * // runtime
 * const result = yield* getRun({ id: runId });
 * ```
 */
export interface GetRun extends Binding.Service<
  GetRun,
  "AWS.Omics.GetRun",
  () => Effect.Effect<
    (
      request?: GetRunRequest,
    ) => Effect.Effect<omics.GetRunResponse, omics.GetRunError>
  >
> {}

export const GetRun = Binding.Service<GetRun>("AWS.Omics.GetRun");
