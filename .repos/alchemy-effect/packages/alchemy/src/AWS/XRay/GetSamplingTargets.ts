import type * as xray from "@distilled.cloud/aws/xray";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetSamplingTargetsRequest
  extends xray.GetSamplingTargetsRequest {}

/**
 * Report sampling statistics and receive updated sampling quotas — the
 * second half of the sampling protocol implemented by X-Ray SDK samplers.
 *
 * Bind the operation in the function's init phase to get a runtime callable;
 * provide the implementation with `Effect.provide(XRay.GetSamplingTargetsHttp)`.
 * The action is account-scoped: X-Ray does not support resource-level
 * permissions for `xray:GetSamplingTargets`, so the binding grants it on `*`.
 * @binding
 * @section Sampling
 * @example Refresh sampling quotas
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * // init — grants xray:GetSamplingTargets
 * const getSamplingTargets = yield* XRay.GetSamplingTargets();
 *
 * // runtime — report what this client sampled and receive new quotas
 * const targets = yield* getSamplingTargets({
 *   SamplingStatisticsDocuments: [
 *     {
 *       RuleName: "my-rule",
 *       ClientID: "0123456789abcdef01234567",
 *       Timestamp: new Date(),
 *       RequestCount: 100,
 *       SampledCount: 5,
 *     },
 *   ],
 * });
 * const documents = targets.SamplingTargetDocuments ?? [];
 * ```
 */
export interface GetSamplingTargets extends Binding.Service<
  GetSamplingTargets,
  "AWS.XRay.GetSamplingTargets",
  () => Effect.Effect<
    (
      request: GetSamplingTargetsRequest,
    ) => Effect.Effect<
      xray.GetSamplingTargetsResult,
      xray.GetSamplingTargetsError
    >
  >
> {}
export const GetSamplingTargets = Binding.Service<GetSamplingTargets>(
  "AWS.XRay.GetSamplingTargets",
);
