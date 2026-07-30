import type * as geoPlaces from "@distilled.cloud/aws/geo-places";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-places:SearchNearby` — find places around a
 * geographic position, optionally filtered by radius, bounding box,
 * categories, or food types.
 *
 * geo-places is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-places:SearchNearby`. Requests and responses are raw distilled types
 * (no marshalling).
 *
 * @binding
 * @section Searching Nearby Places
 * Provide the `SearchNearbyHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoPlaces.SearchNearbyHttp))`), bind in the
 * init phase, then call the client at runtime.
 *
 * @example Find places around a position
 * ```typescript
 * // init
 * const searchNearby = yield* AWS.GeoPlaces.SearchNearby();
 *
 * // runtime
 * const result = yield* searchNearby({
 *   QueryPosition: [-122.3493, 47.6205], // [lng, lat]
 *   QueryRadius: 1000,
 *   MaxResults: 5,
 * });
 * const titles = result.ResultItems?.map((item) => item.Title);
 * ```
 */
export interface SearchNearby extends Binding.Service<
  SearchNearby,
  "AWS.GeoPlaces.SearchNearby",
  () => Effect.Effect<
    (
      request: geoPlaces.SearchNearbyRequest,
    ) => Effect.Effect<
      geoPlaces.SearchNearbyResponse,
      geoPlaces.SearchNearbyError
    >
  >
> {}
export const SearchNearby = Binding.Service<SearchNearby>(
  "AWS.GeoPlaces.SearchNearby",
);
