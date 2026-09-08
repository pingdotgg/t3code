import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:GetCostEstimation`.
 *
 * Returns the result of the most recent cost estimation started with `StartCostEstimation` — the estimated monthly cost of DevOps Guru analyzing the candidate resource collection.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.GetCostEstimationHttp)`.
 * ### Cost Estimation
 * **Example:** Read the Latest Estimate
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getCostEstimation = yield* AWS.DevOpsGuru.GetCostEstimation();
 *
 * // runtime
 * const estimate = yield* getCostEstimation();
 * yield* Effect.log(`estimated: ${estimate.TotalCost} (${estimate.Status})`);
 * ```
 *
 * @binding
 */
export interface GetCostEstimation extends Binding.Service<
  GetCostEstimation,
  "AWS.DevOpsGuru.GetCostEstimation",
  () => Effect.Effect<
    (
      request?: devopsguru.GetCostEstimationRequest,
    ) => Effect.Effect<
      devopsguru.GetCostEstimationResponse,
      devopsguru.GetCostEstimationError
    >
  >
> {}
export const GetCostEstimation = Binding.Service<GetCostEstimation>(
  "AWS.DevOpsGuru.GetCostEstimation",
);
