import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetCostAndUsageWithResources}.
 */
export interface GetCostAndUsageWithResourcesRequest
  extends ce.GetCostAndUsageWithResourcesRequest {}

/**
 * Runtime binding for `ce:GetCostAndUsageWithResources`.
 *
 * Query cost and usage at individual-resource granularity (EC2
 * instance ids etc.). Requires resource-level data to be enabled in Cost
 * Explorer settings and only covers the trailing 14 days. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetCostAndUsageWithResourcesHttp)`.
 * @binding
 * @section Querying Cost and Usage
 * @example Query Resource-Level Cost
 * ```typescript
 * // init — account-level binding takes no resource
 * const getCostAndUsageWithResources = yield* AWS.CostExplorer.GetCostAndUsageWithResources();
 *
 * // runtime
 * const result = yield* getCostAndUsageWithResources({
 *   TimePeriod: { Start: "2026-07-01", End: "2026-07-14" },
 *   Granularity: "DAILY",
 *   Filter: { Dimensions: { Key: "SERVICE", Values: ["Amazon Elastic Compute Cloud - Compute"] } },
 *   Metrics: ["UnblendedCost"],
 * });
 * ```
 */
export interface GetCostAndUsageWithResources extends Binding.Service<
  GetCostAndUsageWithResources,
  "AWS.CostExplorer.GetCostAndUsageWithResources",
  () => Effect.Effect<
    (
      request: GetCostAndUsageWithResourcesRequest,
    ) => Effect.Effect<
      ce.GetCostAndUsageWithResourcesResponse,
      ce.GetCostAndUsageWithResourcesError
    >
  >
> {}

export const GetCostAndUsageWithResources =
  Binding.Service<GetCostAndUsageWithResources>(
    "AWS.CostExplorer.GetCostAndUsageWithResources",
  );
