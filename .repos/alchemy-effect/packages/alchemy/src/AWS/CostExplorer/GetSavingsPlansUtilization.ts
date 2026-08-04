import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetSavingsPlansUtilization}.
 */
export interface GetSavingsPlansUtilizationRequest
  extends ce.GetSavingsPlansUtilizationRequest {}

/**
 * Runtime binding for `ce:GetSavingsPlansUtilization`.
 *
 * Retrieve aggregate Savings Plans utilization across a date range
 * with daily or monthly granularity. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetSavingsPlansUtilizationHttp)`.
 * @binding
 * @section Savings Plans
 * @example Check Savings Plans Utilization
 * ```typescript
 * // init — account-level binding takes no resource
 * const getSavingsPlansUtilization = yield* AWS.CostExplorer.GetSavingsPlansUtilization();
 *
 * // runtime
 * const result = yield* getSavingsPlansUtilization({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 * });
 * ```
 */
export interface GetSavingsPlansUtilization extends Binding.Service<
  GetSavingsPlansUtilization,
  "AWS.CostExplorer.GetSavingsPlansUtilization",
  () => Effect.Effect<
    (
      request: GetSavingsPlansUtilizationRequest,
    ) => Effect.Effect<
      ce.GetSavingsPlansUtilizationResponse,
      ce.GetSavingsPlansUtilizationError
    >
  >
> {}

export const GetSavingsPlansUtilization =
  Binding.Service<GetSavingsPlansUtilization>(
    "AWS.CostExplorer.GetSavingsPlansUtilization",
  );
