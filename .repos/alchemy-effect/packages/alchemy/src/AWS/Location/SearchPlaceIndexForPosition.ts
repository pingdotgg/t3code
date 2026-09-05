import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaceIndex } from "./PlaceIndex.ts";

/**
 * `SearchPlaceIndexForPosition` request with `IndexName` injected from the bound
 * resource.
 */
export interface SearchPlaceIndexForPositionRequest extends Omit<
  location.SearchPlaceIndexForPositionRequest,
  "IndexName"
> {}

/**
 * Reverse-geocodes a coordinate into the nearest addresses and places.
 *
 * Runtime binding for the `SearchPlaceIndexForPosition` operation (IAM action
 * `geo:SearchPlaceIndexForPosition`), scoped to one {@link PlaceIndex}. Provide the implementation with
 * `Effect.provide(AWS.Location.SearchPlaceIndexForPositionHttp)`.
 *
 * @binding
 * @section Searching Places
 * @example Reverse-Geocode a Coordinate
 * ```typescript
 * const searchPosition = yield* Location.SearchPlaceIndexForPosition(index);
 *
 * const results = yield* searchPosition({
 *   Position: [-122.3493, 47.6205], // [longitude, latitude]
 *   MaxResults: 1,
 * });
 * // results.Results[0].Place.Label → nearest address
 * ```
 */
export interface SearchPlaceIndexForPosition extends Binding.Service<
  SearchPlaceIndexForPosition,
  "AWS.Location.SearchPlaceIndexForPosition",
  (
    index: PlaceIndex,
  ) => Effect.Effect<
    (
      request: SearchPlaceIndexForPositionRequest,
    ) => Effect.Effect<
      location.SearchPlaceIndexForPositionResponse,
      location.SearchPlaceIndexForPositionError
    >
  >
> {}
export const SearchPlaceIndexForPosition =
  Binding.Service<SearchPlaceIndexForPosition>(
    "AWS.Location.SearchPlaceIndexForPosition",
  );
