import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CancelRunRequest extends omics.CancelRunRequest {}

/**
 * Runtime binding for `omics:CancelRun`.
 *
 * An account-level run-control operation (no resource argument) that cancels an in-progress run.
 * Provide the implementation with `Effect.provide(AWS.Omics.CancelRunHttp)`.
 * @binding
 * @section Runs
 * @example Call CancelRun
 * ```typescript
 * // init — account-level binding takes no resource
 * const cancelRun = yield* AWS.Omics.CancelRun();
 * // runtime
 * const result = yield* cancelRun({ id: runId });
 * ```
 */
export interface CancelRun extends Binding.Service<
  CancelRun,
  "AWS.Omics.CancelRun",
  () => Effect.Effect<
    (
      request?: CancelRunRequest,
    ) => Effect.Effect<omics.CancelRunResponse, omics.CancelRunError>
  >
> {}

export const CancelRun = Binding.Service<CancelRun>("AWS.Omics.CancelRun");
