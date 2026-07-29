import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetCostAndUsage}.
 */
export interface GetCostAndUsageRequest extends ce.GetCostAndUsageRequest {}

/**
 * Runtime binding for `ce:GetCostAndUsage`.
 *
 * Query cost and usage metrics (`UnblendedCost`, `UsageQuantity`, …)
 * filtered and grouped by dimension over a time range — the core Cost
 * Explorer query. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetCostAndUsageHttp)`.
 * @binding
 * @section Querying Cost and Usage
 * @example Query Last Month's Unblended Cost
 * ```typescript
 * // init — account-level binding takes no resource
 * const getCostAndUsage = yield* AWS.CostExplorer.GetCostAndUsage();
 *
 * // runtime
 * const result = yield* getCostAndUsage({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 *   Granularity: "MONTHLY",
 *   Metrics: ["UnblendedCost"],
 * });
 * const total = result.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount;
 * ```
 */
export interface GetCostAndUsage extends Binding.Service<
  GetCostAndUsage,
  "AWS.CostExplorer.GetCostAndUsage",
  () => Effect.Effect<
    (
      request: GetCostAndUsageRequest,
    ) => Effect.Effect<ce.GetCostAndUsageResponse, ce.GetCostAndUsageError>
  >
> {}

export const GetCostAndUsage = Binding.Service<GetCostAndUsage>(
  "AWS.CostExplorer.GetCostAndUsage",
);
