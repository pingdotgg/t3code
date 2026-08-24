import type * as geoRoutes from "@distilled.cloud/aws/geo-routes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-routes:CalculateIsolines` — compute areas
 * reachable within time or distance thresholds from a point (isochrones /
 * isodistances), e.g. "everywhere within a 30-minute drive".
 *
 * geo-routes is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-routes:CalculateIsolines`. Requests and responses are raw distilled
 * types (`Origin` is a `[longitude, latitude]` pair).
 *
 * @binding
 * @section Calculating Isolines
 * Provide the `CalculateIsolinesHttp` implementation layer on the Function
 * effect (`.pipe(Effect.provide(AWS.GeoRoutes.CalculateIsolinesHttp))`), bind
 * in the init phase, then call the client at runtime.
 *
 * @example Calculate a 10-minute drive-time isoline
 * ```typescript
 * // init
 * const calculateIsolines = yield* AWS.GeoRoutes.CalculateIsolines();
 *
 * // runtime — coordinates are [longitude, latitude]; thresholds in seconds
 * const result = yield* calculateIsolines({
 *   Origin: [-122.339, 47.61],
 *   Thresholds: { Time: [600] },
 *   TravelMode: "Car",
 * });
 * const polygons = result.Isolines[0]?.Geometries;
 * ```
 */
export interface CalculateIsolines extends Binding.Service<
  CalculateIsolines,
  "AWS.GeoRoutes.CalculateIsolines",
  () => Effect.Effect<
    (
      request: geoRoutes.CalculateIsolinesRequest,
    ) => Effect.Effect<
      geoRoutes.CalculateIsolinesResponse,
      geoRoutes.CalculateIsolinesError
    >
  >
> {}
export const CalculateIsolines = Binding.Service<CalculateIsolines>(
  "AWS.GeoRoutes.CalculateIsolines",
);
