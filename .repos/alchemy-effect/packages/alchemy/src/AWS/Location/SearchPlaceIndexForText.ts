import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaceIndex } from "./PlaceIndex.ts";

/**
 * `SearchPlaceIndexForText` request with `IndexName` injected from the bound
 * resource.
 */
export interface SearchPlaceIndexForTextRequest extends Omit<
  location.SearchPlaceIndexForTextRequest,
  "IndexName"
> {}

/**
 * Geocodes a free-form text query (address, place name, business) into ranked places with coordinates.
 *
 * Runtime binding for the `SearchPlaceIndexForText` operation (IAM action
 * `geo:SearchPlaceIndexForText`), scoped to one {@link PlaceIndex}. Provide the implementation with
 * `Effect.provide(AWS.Location.SearchPlaceIndexForTextHttp)`.
 *
 * @binding
 * @section Searching Places
 * @example Geocode an Address
 * ```typescript
 * const searchText = yield* Location.SearchPlaceIndexForText(index);
 *
 * const results = yield* searchText({
 *   Text: "Space Needle, Seattle, WA",
 *   MaxResults: 3,
 * });
 * // results.Results[0].Place.Geometry.Point → [longitude, latitude]
 * ```
 */
export interface SearchPlaceIndexForText extends Binding.Service<
  SearchPlaceIndexForText,
  "AWS.Location.SearchPlaceIndexForText",
  (
    index: PlaceIndex,
  ) => Effect.Effect<
    (
      request: SearchPlaceIndexForTextRequest,
    ) => Effect.Effect<
      location.SearchPlaceIndexForTextResponse,
      location.SearchPlaceIndexForTextError
    >
  >
> {}
export const SearchPlaceIndexForText = Binding.Service<SearchPlaceIndexForText>(
  "AWS.Location.SearchPlaceIndexForText",
);
