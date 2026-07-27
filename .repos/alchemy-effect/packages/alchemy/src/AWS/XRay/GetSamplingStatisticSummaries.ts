import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetSamplingStatisticSummariesRequest
  extends xray.GetSamplingStatisticSummariesRequest {}

/**
 * Retrieve recent aggregate sampling results (requests matched, sampled,
 * and borrowed) for every sampling rule.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetSamplingStatisticSummariesHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetSamplingStatisticSummaries`, so the binding grants it on `*`.
 * @binding
 * @section Sampling
 * @example Inspect recent sampling activity
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetSamplingStatisticSummaries
 * const getSamplingStatisticSummaries =
 *   yield* XRay.GetSamplingStatisticSummaries();
 *
 * // runtime
 * const summaries = yield* getSamplingStatisticSummaries();
 * const perRule = summaries.SamplingStatisticSummaries ?? [];
 * ```
 */
export interface GetSamplingStatisticSummaries extends Binding.Service<
  GetSamplingStatisticSummaries,
  "AWS.XRay.GetSamplingStatisticSummaries",
  () => Effect.Effect<
    (
      request?: GetSamplingStatisticSummariesRequest,
    ) => Effect.Effect<
      xray.GetSamplingStatisticSummariesResult,
      xray.GetSamplingStatisticSummariesError
    >
  >
> {}
export const GetSamplingStatisticSummaries =
  Binding.Service<GetSamplingStatisticSummaries>(
    "AWS.XRay.GetSamplingStatisticSummaries",
  );
