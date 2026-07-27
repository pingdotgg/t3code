import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetCostAndUsageComparisons}.
 */
export interface GetCostAndUsageComparisonsRequest
  extends ce.GetCostAndUsageComparisonsRequest {}

/**
 * Runtime binding for `ce:GetCostAndUsageComparisons`.
 *
 * Compare cost and usage between two periods within the last 13
 * months (up to 38 months with multi-year data enabled). Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetCostAndUsageComparisonsHttp)`.
 * @binding
 * @section Querying Cost and Usage
 * @example Compare Two Billing Periods
 * ```typescript
 * // init — account-level binding takes no resource
 * const getCostAndUsageComparisons = yield* AWS.CostExplorer.GetCostAndUsageComparisons();
 *
 * // runtime
 * const result = yield* getCostAndUsageComparisons({
 *   BaselineTimePeriod: { Start: "2026-05-01", End: "2026-06-01" },
 *   ComparisonTimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 *   MetricForComparison: "UnblendedCost",
 * });
 * ```
 */
export interface GetCostAndUsageComparisons extends Binding.Service<
  GetCostAndUsageComparisons,
  "AWS.CostExplorer.GetCostAndUsageComparisons",
  () => Effect.Effect<
    (
      request: GetCostAndUsageComparisonsRequest,
    ) => Effect.Effect<
      ce.GetCostAndUsageComparisonsResponse,
      ce.GetCostAndUsageComparisonsError
    >
  >
> {}

export const GetCostAndUsageComparisons =
  Binding.Service<GetCostAndUsageComparisons>(
    "AWS.CostExplorer.GetCostAndUsageComparisons",
  );
