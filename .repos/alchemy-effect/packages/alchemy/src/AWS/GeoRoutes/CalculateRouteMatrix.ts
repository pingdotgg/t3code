import type * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-routes:CalculateRouteMatrix` — compute travel time
 * and distance for all pairs of origins to destinations in one call (an
 * origin-destination cost matrix), e.g. rank the nearest store for each
 * customer.
 *
 * geo-routes is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-routes:CalculateRouteMatrix`. Requests and responses are raw distilled
 * types (positions are `[longitude, latitude]` pairs). The matrix requires a
 * `RoutingBoundary` — a geometry that contains all origins and destinations,
 * or `{ Unbounded: true }`.
 *
 * @binding
 * @section Calculating a Route Matrix
 * Provide the `CalculateRouteMatrixHttp` implementation layer on the Function
 * effect (`.pipe(Effect.provide(AWS.GeoRoutes.CalculateRouteMatrixHttp))`),
 * bind in the init phase, then call the client at runtime.
 *
 * @example Calculate a 2x2 origin-destination matrix
 * ```typescript
 * // init
 * const calculateRouteMatrix = yield* AWS.GeoRoutes.CalculateRouteMatrix();
 *
 * // runtime — positions are [longitude, latitude]
 * const result = yield* calculateRouteMatrix({
 *   Origins: [
 *     { Position: [-122.339, 47.61] },
 *     { Position: [-122.335, 47.608] },
 *   ],
 *   Destinations: [
 *     { Position: [-122.201, 47.61] },
 *     { Position: [-122.313, 47.62] },
 *   ],
 *   RoutingBoundary: {
 *     Geometry: { Circle: { Center: [-122.3, 47.61], Radius: 30_000 } },
 *   },
 * });
 * const secondsFromFirstOriginToFirstDestination =
 *   result.RouteMatrix[0]?.[0]?.Duration;
 * ```
 */
export interface CalculateRouteMatrix extends Binding.Service<
  CalculateRouteMatrix,
  "AWS.GeoRoutes.CalculateRouteMatrix",
  () => Effect.Effect<
    (
      request: geoRoutes.CalculateRouteMatrixRequest,
    ) => Effect.Effect<
      geoRoutes.CalculateRouteMatrixResponse,
      geoRoutes.CalculateRouteMatrixError
    >
  >
> {}
export const CalculateRouteMatrix = Binding.Service<CalculateRouteMatrix>(
  "AWS.GeoRoutes.CalculateRouteMatrix",
);
