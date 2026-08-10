import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetSavingsPlansUtilizationDetails}.
 */
export interface GetSavingsPlansUtilizationDetailsRequest
  extends ce.GetSavingsPlansUtilizationDetailsRequest {}

/**
 * Runtime binding for `ce:GetSavingsPlansUtilizationDetails`.
 *
 * Retrieve per-Savings-Plan attribute, utilization, and savings
 * detail for a time period. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetSavingsPlansUtilizationDetailsHttp)`.
 * @binding
 * @section Savings Plans
 * @example Per-Plan Utilization Details
 * ```typescript
 * // init — account-level binding takes no resource
 * const getSavingsPlansUtilizationDetails = yield* AWS.CostExplorer.GetSavingsPlansUtilizationDetails();
 *
 * // runtime
 * const result = yield* getSavingsPlansUtilizationDetails({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 * });
 * ```
 */
export interface GetSavingsPlansUtilizationDetails extends Binding.Service<
  GetSavingsPlansUtilizationDetails,
  "AWS.CostExplorer.GetSavingsPlansUtilizationDetails",
  () => Effect.Effect<
    (
      request: GetSavingsPlansUtilizationDetailsRequest,
    ) => Effect.Effect<
      ce.GetSavingsPlansUtilizationDetailsResponse,
      ce.GetSavingsPlansUtilizationDetailsError
    >
  >
> {}

export const GetSavingsPlansUtilizationDetails =
  Binding.Service<GetSavingsPlansUtilizationDetails>(
    "AWS.CostExplorer.GetSavingsPlansUtilizationDetails",
  );
