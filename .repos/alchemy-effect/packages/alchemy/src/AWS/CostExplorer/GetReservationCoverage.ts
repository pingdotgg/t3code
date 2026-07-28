import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetReservationCoverage}.
 */
export interface GetReservationCoverageRequest
  extends ce.GetReservationCoverageRequest {}

/**
 * Runtime binding for `ce:GetReservationCoverage`.
 *
 * Retrieve how much of your eligible usage (EC2, RDS, ElastiCache,
 * Redshift, OpenSearch, …) was covered by reservations over a time
 * period. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetReservationCoverageHttp)`.
 * @binding
 * @section Reservations
 * @example Check Reservation Coverage
 * ```typescript
 * // init — account-level binding takes no resource
 * const getReservationCoverage = yield* AWS.CostExplorer.GetReservationCoverage();
 *
 * // runtime
 * const result = yield* getReservationCoverage({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 * });
 * const coverage = result.Total?.CoverageHours?.CoverageHoursPercentage;
 * ```
 */
export interface GetReservationCoverage extends Binding.Service<
  GetReservationCoverage,
  "AWS.CostExplorer.GetReservationCoverage",
  () => Effect.Effect<
    (
      request: GetReservationCoverageRequest,
    ) => Effect.Effect<
      ce.GetReservationCoverageResponse,
      ce.GetReservationCoverageError
    >
  >
> {}

export const GetReservationCoverage = Binding.Service<GetReservationCoverage>(
  "AWS.CostExplorer.GetReservationCoverage",
);
