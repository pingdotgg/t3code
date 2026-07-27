import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetSavingsPlansCoverage}.
 */
export interface GetSavingsPlansCoverageRequest
  extends ce.GetSavingsPlansCoverageRequest {}

/**
 * Runtime binding for `ce:GetSavingsPlansCoverage`.
 *
 * Retrieve how much of your eligible spend was covered by Savings
 * Plans over a time period. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetSavingsPlansCoverageHttp)`.
 * @binding
 * @section Savings Plans
 * @example Check Savings Plans Coverage
 * ```typescript
 * // init — account-level binding takes no resource
 * const getSavingsPlansCoverage = yield* AWS.CostExplorer.GetSavingsPlansCoverage();
 *
 * // runtime
 * const result = yield* getSavingsPlansCoverage({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 * });
 * ```
 */
export interface GetSavingsPlansCoverage extends Binding.Service<
  GetSavingsPlansCoverage,
  "AWS.CostExplorer.GetSavingsPlansCoverage",
  () => Effect.Effect<
    (
      request: GetSavingsPlansCoverageRequest,
    ) => Effect.Effect<
      ce.GetSavingsPlansCoverageResponse,
      ce.GetSavingsPlansCoverageError
    >
  >
> {}

export const GetSavingsPlansCoverage = Binding.Service<GetSavingsPlansCoverage>(
  "AWS.CostExplorer.GetSavingsPlansCoverage",
);
