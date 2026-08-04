import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetApproximateUsageRecords}.
 */
export interface GetApproximateUsageRecordsRequest
  extends ce.GetApproximateUsageRecordsRequest {}

/**
 * Runtime binding for `ce:GetApproximateUsageRecords`.
 *
 * Retrieve estimated counts of hourly (or daily resource-level)
 * usage records per service — useful for sizing Data Exports and CUR
 * deliveries before enabling them. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetApproximateUsageRecordsHttp)`.
 * @binding
 * @section Querying Cost and Usage
 * @example Estimate Usage Record Volume
 * ```typescript
 * // init — account-level binding takes no resource
 * const getApproximateUsageRecords = yield* AWS.CostExplorer.GetApproximateUsageRecords();
 *
 * // runtime
 * const result = yield* getApproximateUsageRecords({
 *   Granularity: "HOURLY",
 *   ApproximationDimension: "SERVICE",
 * });
 * const total = result.TotalRecords;
 * ```
 */
export interface GetApproximateUsageRecords extends Binding.Service<
  GetApproximateUsageRecords,
  "AWS.CostExplorer.GetApproximateUsageRecords",
  () => Effect.Effect<
    (
      request: GetApproximateUsageRecordsRequest,
    ) => Effect.Effect<
      ce.GetApproximateUsageRecordsResponse,
      ce.GetApproximateUsageRecordsError
    >
  >
> {}

export const GetApproximateUsageRecords =
  Binding.Service<GetApproximateUsageRecords>(
    "AWS.CostExplorer.GetApproximateUsageRecords",
  );
