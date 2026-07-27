import type * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-routes:OptimizeWaypoints` — calculate the optimal
 * order to visit a set of waypoints, minimizing travel time or distance
 * (the traveling-salesman step of delivery/route planning).
 *
 * geo-routes is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-routes:OptimizeWaypoints`. Requests and responses are raw distilled
 * types (positions are `[longitude, latitude]` pairs).
 *
 * @binding
 * @section Optimizing Waypoints
 * Provide the `OptimizeWaypointsHttp` implementation layer on the Function
 * effect (`.pipe(Effect.provide(AWS.GeoRoutes.OptimizeWaypointsHttp))`), bind
 * in the init phase, then call the client at runtime.
 *
 * @example Optimize the visiting order of two stops
 * ```typescript
 * // init
 * const optimizeWaypoints = yield* AWS.GeoRoutes.OptimizeWaypoints();
 *
 * // runtime — positions are [longitude, latitude]
 * const result = yield* optimizeWaypoints({
 *   Origin: [-122.339, 47.61],
 *   Destination: [-122.201, 47.61],
 *   Waypoints: [
 *     { Id: "stop-1", Position: [-122.335, 47.608] },
 *     { Id: "stop-2", Position: [-122.313, 47.62] },
 *   ],
 * });
 * const order = result.OptimizedWaypoints.map((w) => w.Id);
 * ```
 */
export interface OptimizeWaypoints extends Binding.Service<
  OptimizeWaypoints,
  "AWS.GeoRoutes.OptimizeWaypoints",
  () => Effect.Effect<
    (
      request: geoRoutes.OptimizeWaypointsRequest,
    ) => Effect.Effect<
      geoRoutes.OptimizeWaypointsResponse,
      geoRoutes.OptimizeWaypointsError
    >
  >
> {}
export const OptimizeWaypoints = Binding.Service<OptimizeWaypoints>(
  "AWS.GeoRoutes.OptimizeWaypoints",
);
