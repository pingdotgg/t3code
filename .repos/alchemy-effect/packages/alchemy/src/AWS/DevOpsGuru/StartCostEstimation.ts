import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:StartCostEstimation`.
 *
 * Starts estimating the monthly cost of DevOps Guru analyzing a candidate resource collection. Poll the result with `GetCostEstimation`.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.StartCostEstimationHttp)`.
 * @binding
 * @section Cost Estimation
 * @example Estimate the Cost of Coverage
 * ```typescript
 * // init — account-level binding, no resource argument
 * const startCostEstimation = yield* AWS.DevOpsGuru.StartCostEstimation();
 *
 * // runtime
 * yield* startCostEstimation({
 *   ResourceCollection: { CloudFormation: { StackNames: ["my-app-prod"] } },
 * });
 * ```
 */
export interface StartCostEstimation extends Binding.Service<
  StartCostEstimation,
  "AWS.DevOpsGuru.StartCostEstimation",
  () => Effect.Effect<
    (
      request: devopsguru.StartCostEstimationRequest,
    ) => Effect.Effect<
      devopsguru.StartCostEstimationResponse,
      devopsguru.StartCostEstimationError
    >
  >
> {}
export const StartCostEstimation = Binding.Service<StartCostEstimation>(
  "AWS.DevOpsGuru.StartCostEstimation",
);
