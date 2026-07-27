import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetReservationUtilization}.
 */
export interface GetReservationUtilizationRequest
  extends ce.GetReservationUtilizationRequest {}

/**
 * Runtime binding for `ce:GetReservationUtilization`.
 *
 * Retrieve how fully your reservations were utilized over a time
 * range, optionally grouped by subscription. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetReservationUtilizationHttp)`.
 * @binding
 * @section Reservations
 * @example Check Reservation Utilization
 * ```typescript
 * // init — account-level binding takes no resource
 * const getReservationUtilization = yield* AWS.CostExplorer.GetReservationUtilization();
 *
 * // runtime
 * const result = yield* getReservationUtilization({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 * });
 * const utilization = result.Total?.UtilizationPercentage;
 * ```
 */
export interface GetReservationUtilization extends Binding.Service<
  GetReservationUtilization,
  "AWS.CostExplorer.GetReservationUtilization",
  () => Effect.Effect<
    (
      request: GetReservationUtilizationRequest,
    ) => Effect.Effect<
      ce.GetReservationUtilizationResponse,
      ce.GetReservationUtilizationError
    >
  >
> {}

export const GetReservationUtilization =
  Binding.Service<GetReservationUtilization>(
    "AWS.CostExplorer.GetReservationUtilization",
  );
