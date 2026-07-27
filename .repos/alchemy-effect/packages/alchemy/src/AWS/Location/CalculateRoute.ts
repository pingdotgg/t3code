import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RouteCalculator } from "./RouteCalculator.ts";

/**
 * `CalculateRoute` request with `CalculatorName` injected from the bound
 * resource.
 */
export interface CalculateRouteRequest extends Omit<
  location.CalculateRouteRequest,
  "CalculatorName"
> {}

/**
 * Calculates a route (distance, duration, and legs) between a departure and a destination position.
 *
 * Runtime binding for the `CalculateRoute` operation (IAM action
 * `geo:CalculateRoute`), scoped to one {@link RouteCalculator}. Provide the implementation with
 * `Effect.provide(AWS.Location.CalculateRouteHttp)`.
 *
 * @binding
 * @section Calculating Routes
 * @example Calculate a Route
 * ```typescript
 * const calculateRoute = yield* Location.CalculateRoute(calculator);
 *
 * const route = yield* calculateRoute({
 *   DeparturePosition: [-122.3493, 47.6205],
 *   DestinationPosition: [-122.3321, 47.6062],
 * });
 * // route.Summary.Distance, route.Summary.DurationSeconds
 * ```
 */
export interface CalculateRoute extends Binding.Service<
  CalculateRoute,
  "AWS.Location.CalculateRoute",
  (
    calculator: RouteCalculator,
  ) => Effect.Effect<
    (
      request: CalculateRouteRequest,
    ) => Effect.Effect<
      location.CalculateRouteResponse,
      location.CalculateRouteError
    >
  >
> {}
export const CalculateRoute = Binding.Service<CalculateRoute>(
  "AWS.Location.CalculateRoute",
);
