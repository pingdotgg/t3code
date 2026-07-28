import type * as geoPlaces from "@distilled.cloud/aws/geo-places";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-places:GetPlace` — fetch the full details of a
 * place (address, contacts, opening hours, time zone, …) by its `PlaceId`,
 * as returned by Geocode, SearchText, SearchNearby, Suggest, or
 * Autocomplete.
 *
 * geo-places is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-places:GetPlace`. Requests and responses are raw distilled types (no
 * marshalling).
 *
 * @binding
 * @section Fetching Place Details
 * Provide the `GetPlaceHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoPlaces.GetPlaceHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Look up a place by its PlaceId
 * ```typescript
 * // init
 * const geocode = yield* AWS.GeoPlaces.Geocode();
 * const getPlace = yield* AWS.GeoPlaces.GetPlace();
 *
 * // runtime
 * const geocoded = yield* geocode({ QueryText: "Space Needle, Seattle" });
 * const placeId = geocoded.ResultItems?.[0]?.PlaceId;
 * const place = yield* getPlace({ PlaceId: placeId! });
 * const label = place.Address?.Label;
 * ```
 */
export interface GetPlace extends Binding.Service<
  GetPlace,
  "AWS.GeoPlaces.GetPlace",
  () => Effect.Effect<
    (
      request: geoPlaces.GetPlaceRequest,
    ) => Effect.Effect<geoPlaces.GetPlaceResponse, geoPlaces.GetPlaceError>
  >
> {}
export const GetPlace = Binding.Service<GetPlace>("AWS.GeoPlaces.GetPlace");
