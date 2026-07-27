import type * as geoPlaces from "@distilled.cloud/aws/geo-places";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-places:ReverseGeocode` — convert geographic
 * coordinates into a human-readable address or place, with optional filtering
 * by place type and additional features such as time zones.
 *
 * geo-places is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-places:ReverseGeocode`. Requests and responses are raw distilled types
 * (no marshalling).
 *
 * @binding
 * @section Reverse Geocoding
 * Provide the `ReverseGeocodeHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoPlaces.ReverseGeocodeHttp))`), bind in the
 * init phase, then call the client at runtime.
 *
 * @example Reverse geocode a position
 * ```typescript
 * // init
 * const reverseGeocode = yield* AWS.GeoPlaces.ReverseGeocode();
 *
 * // runtime
 * const result = yield* reverseGeocode({
 *   QueryPosition: [-122.3381, 47.6101], // [longitude, latitude]
 *   MaxResults: 1,
 * });
 * const address = result.ResultItems?.[0]?.Address?.Label;
 * ```
 */
export interface ReverseGeocode extends Binding.Service<
  ReverseGeocode,
  "AWS.GeoPlaces.ReverseGeocode",
  () => Effect.Effect<
    (
      request: geoPlaces.ReverseGeocodeRequest,
    ) => Effect.Effect<
      geoPlaces.ReverseGeocodeResponse,
      geoPlaces.ReverseGeocodeError
    >
  >
> {}
export const ReverseGeocode = Binding.Service<ReverseGeocode>(
  "AWS.GeoPlaces.ReverseGeocode",
);
