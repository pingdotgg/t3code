import type * as geoPlaces from "@distilled.cloud/aws/geo-places";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-places:Geocode` — convert an address or place
 * description into geographic coordinates.
 *
 * geo-places is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-places:Geocode`. Requests and responses are raw distilled types (no
 * marshalling).
 *
 * @binding
 * @section Geocoding Addresses
 * Provide the `GeocodeHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoPlaces.GeocodeHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Geocode an address to coordinates
 * ```typescript
 * // init
 * const geocode = yield* AWS.GeoPlaces.Geocode();
 *
 * // runtime
 * const result = yield* geocode({
 *   QueryText: "1600 Pennsylvania Ave NW, Washington, DC",
 * });
 * const position = result.ResultItems?.[0]?.Position; // [lng, lat]
 * ```
 */
export interface Geocode extends Binding.Service<
  Geocode,
  "AWS.GeoPlaces.Geocode",
  () => Effect.Effect<
    (
      request: geoPlaces.GeocodeRequest,
    ) => Effect.Effect<geoPlaces.GeocodeResponse, geoPlaces.GeocodeError>
  >
> {}
export const Geocode = Binding.Service<Geocode>("AWS.GeoPlaces.Geocode");
