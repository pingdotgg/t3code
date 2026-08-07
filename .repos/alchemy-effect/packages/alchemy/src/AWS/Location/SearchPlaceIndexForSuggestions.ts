import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaceIndex } from "./PlaceIndex.ts";

/**
 * `SearchPlaceIndexForSuggestions` request with `IndexName` injected from the bound
 * resource.
 */
export interface SearchPlaceIndexForSuggestionsRequest extends Omit<
  location.SearchPlaceIndexForSuggestionsRequest,
  "IndexName"
> {}

/**
 * Returns typeahead suggestions for a partial text query (autocomplete).
 *
 * Runtime binding for the `SearchPlaceIndexForSuggestions` operation (IAM action
 * `geo:SearchPlaceIndexForSuggestions`), scoped to one {@link PlaceIndex}. Provide the implementation with
 * `Effect.provide(AWS.Location.SearchPlaceIndexForSuggestionsHttp)`.
 *
 * @binding
 * @section Searching Places
 * @example Autocomplete a Query
 * ```typescript
 * const suggest = yield* Location.SearchPlaceIndexForSuggestions(index);
 *
 * const results = yield* suggest({
 *   Text: "coffee",
 *   BiasPosition: [-122.3493, 47.6205],
 *   MaxResults: 5,
 * });
 * // results.Results → [{ Text, PlaceId }, …]
 * ```
 */
export interface SearchPlaceIndexForSuggestions extends Binding.Service<
  SearchPlaceIndexForSuggestions,
  "AWS.Location.SearchPlaceIndexForSuggestions",
  (
    index: PlaceIndex,
  ) => Effect.Effect<
    (
      request: SearchPlaceIndexForSuggestionsRequest,
    ) => Effect.Effect<
      location.SearchPlaceIndexForSuggestionsResponse,
      location.SearchPlaceIndexForSuggestionsError
    >
  >
> {}
export const SearchPlaceIndexForSuggestions =
  Binding.Service<SearchPlaceIndexForSuggestions>(
    "AWS.Location.SearchPlaceIndexForSuggestions",
  );
