import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetCostComparisonDrivers}.
 */
export interface GetCostComparisonDriversRequest
  extends ce.GetCostComparisonDriversRequest {}

/**
 * Runtime binding for `ce:GetCostComparisonDrivers`.
 *
 * Retrieve the top cost drivers explaining the change between two
 * billing periods — which services, accounts, or usage types moved the
 * bill. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetCostComparisonDriversHttp)`.
 * @binding
 * @section Querying Cost and Usage
 * @example Find What Drove a Cost Change
 * ```typescript
 * // init — account-level binding takes no resource
 * const getCostComparisonDrivers = yield* AWS.CostExplorer.GetCostComparisonDrivers();
 *
 * // runtime
 * const result = yield* getCostComparisonDrivers({
 *   BaselineTimePeriod: { Start: "2026-05-01", End: "2026-06-01" },
 *   ComparisonTimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 *   MetricForComparison: "UnblendedCost",
 * });
 * ```
 */
export interface GetCostComparisonDrivers extends Binding.Service<
  GetCostComparisonDrivers,
  "AWS.CostExplorer.GetCostComparisonDrivers",
  () => Effect.Effect<
    (
      request: GetCostComparisonDriversRequest,
    ) => Effect.Effect<
      ce.GetCostComparisonDriversResponse,
      ce.GetCostComparisonDriversError
    >
  >
> {}

export const GetCostComparisonDrivers =
  Binding.Service<GetCostComparisonDrivers>(
    "AWS.CostExplorer.GetCostComparisonDrivers",
  );
