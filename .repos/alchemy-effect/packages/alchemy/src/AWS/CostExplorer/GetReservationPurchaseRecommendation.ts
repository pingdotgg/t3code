import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetReservationPurchaseRecommendation}.
 */
export interface GetReservationPurchaseRecommendationRequest
  extends ce.GetReservationPurchaseRecommendationRequest {}

/**
 * Runtime binding for `ce:GetReservationPurchaseRecommendation`.
 *
 * Get reserved-instance purchase recommendations for a service based
 * on your historical usage. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetReservationPurchaseRecommendationHttp)`.
 * @binding
 * @section Reservations
 * @example Get RI Purchase Recommendations
 * ```typescript
 * // init — account-level binding takes no resource
 * const getReservationPurchaseRecommendation = yield* AWS.CostExplorer.GetReservationPurchaseRecommendation();
 *
 * // runtime
 * const result = yield* getReservationPurchaseRecommendation({
 *   Service: "Amazon Elastic Compute Cloud - Compute",
 * });
 * const recommendations = result.Recommendations;
 * ```
 */
export interface GetReservationPurchaseRecommendation extends Binding.Service<
  GetReservationPurchaseRecommendation,
  "AWS.CostExplorer.GetReservationPurchaseRecommendation",
  () => Effect.Effect<
    (
      request: GetReservationPurchaseRecommendationRequest,
    ) => Effect.Effect<
      ce.GetReservationPurchaseRecommendationResponse,
      ce.GetReservationPurchaseRecommendationError
    >
  >
> {}

export const GetReservationPurchaseRecommendation =
  Binding.Service<GetReservationPurchaseRecommendation>(
    "AWS.CostExplorer.GetReservationPurchaseRecommendation",
  );
