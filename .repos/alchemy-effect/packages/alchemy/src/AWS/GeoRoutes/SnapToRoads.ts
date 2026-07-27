import type * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-routes:SnapToRoads` — match a GPS trace (a list of
 * possibly-noisy trace points) to the roads most likely traveled on, e.g.
 * clean up vehicle telemetry before computing distance driven.
 *
 * geo-routes is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-routes:SnapToRoads`. Requests and responses are raw distilled types
 * (positions are `[longitude, latitude]` pairs).
 *
 * @binding
 * @section Snapping GPS Traces to Roads
 * Provide the `SnapToRoadsHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoRoutes.SnapToRoadsHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Snap a two-point GPS trace to the road network
 * ```typescript
 * // init
 * const snapToRoads = yield* AWS.GeoRoutes.SnapToRoads();
 *
 * // runtime — positions are [longitude, latitude]
 * const result = yield* snapToRoads({
 *   TracePoints: [
 *     { Position: [-122.339, 47.61] },
 *     { Position: [-122.335, 47.608] },
 *   ],
 *   TravelMode: "Car",
 * });
 * const snapped = result.SnappedTracePoints.map((p) => p.SnappedPosition);
 * ```
 */
export interface SnapToRoads extends Binding.Service<
  SnapToRoads,
  "AWS.GeoRoutes.SnapToRoads",
  () => Effect.Effect<
    (
      request: geoRoutes.SnapToRoadsRequest,
    ) => Effect.Effect<
      geoRoutes.SnapToRoadsResponse,
      geoRoutes.SnapToRoadsError
    >
  >
> {}
export const SnapToRoads = Binding.Service<SnapToRoads>(
  "AWS.GeoRoutes.SnapToRoads",
);
