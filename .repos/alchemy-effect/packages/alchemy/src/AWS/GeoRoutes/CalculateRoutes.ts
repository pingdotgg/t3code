import type * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-routes:CalculateRoutes` — compute one or more
 * routes between an origin and a destination, with optional waypoints, travel
 * mode, and traffic options.
 *
 * geo-routes is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-routes:CalculateRoutes`. Requests and responses are raw distilled types
 * (`Origin`/`Destination` are `[longitude, latitude]` pairs).
 *
 * @binding
 * @section Calculating Routes
 * Provide the `CalculateRoutesHttp` implementation layer on the Function
 * effect (`.pipe(Effect.provide(AWS.GeoRoutes.CalculateRoutesHttp))`), bind in
 * the init phase, then call the client at runtime.
 *
 * @example Calculate a route between two points
 * ```typescript
 * // init
 * const calculateRoutes = yield* AWS.GeoRoutes.CalculateRoutes();
 *
 * // runtime — coordinates are [longitude, latitude]
 * const result = yield* calculateRoutes({
 *   Origin: [-122.339, 47.61],
 *   Destination: [-122.201, 47.61],
 *   TravelMode: "Car",
 * });
 * const distanceMeters = result.Routes?.[0]?.Summary?.Distance;
 * ```
 */
export interface CalculateRoutes extends Binding.Service<
  CalculateRoutes,
  "AWS.GeoRoutes.CalculateRoutes",
  () => Effect.Effect<
    (
      request: geoRoutes.CalculateRoutesRequest,
    ) => Effect.Effect<
      geoRoutes.CalculateRoutesResponse,
      geoRoutes.CalculateRoutesError
    >
  >
> {}
export const CalculateRoutes = Binding.Service<CalculateRoutes>(
  "AWS.GeoRoutes.CalculateRoutes",
);
