import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RouteCalculator } from "./RouteCalculator.ts";

/**
 * `CalculateRouteMatrix` request with `CalculatorName` injected from the bound
 * resource.
 */
export interface CalculateRouteMatrixRequest extends Omit<
  location.CalculateRouteMatrixRequest,
  "CalculatorName"
> {}

/**
 * Calculates the distance/duration matrix between sets of departure and destination positions.
 *
 * Runtime binding for the `CalculateRouteMatrix` operation (IAM action
 * `geo:CalculateRouteMatrix`), scoped to one {@link RouteCalculator}. Provide the implementation with
 * `Effect.provide(AWS.Location.CalculateRouteMatrixHttp)`.
 *
 * @binding
 * @section Calculating Routes
 * @example Calculate a Route Matrix
 * ```typescript
 * const calculateMatrix = yield* Location.CalculateRouteMatrix(calculator);
 *
 * const matrix = yield* calculateMatrix({
 *   DeparturePositions: [[-122.3493, 47.6205]],
 *   DestinationPositions: [[-122.3321, 47.6062], [-122.2015, 47.6101]],
 * });
 * // matrix.RouteMatrix[departure][destination].Distance
 * ```
 */
export interface CalculateRouteMatrix extends Binding.Service<
  CalculateRouteMatrix,
  "AWS.Location.CalculateRouteMatrix",
  (
    calculator: RouteCalculator,
  ) => Effect.Effect<
    (
      request: CalculateRouteMatrixRequest,
    ) => Effect.Effect<
      location.CalculateRouteMatrixResponse,
      location.CalculateRouteMatrixError
    >
  >
> {}
export const CalculateRouteMatrix = Binding.Service<CalculateRouteMatrix>(
  "AWS.Location.CalculateRouteMatrix",
);
