import type * as geoPlaces from "@distilled.cloud/aws/geo-places";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-places:SearchText` — free-form place search that
 * returns ranked results (POIs, addresses, streets) for a text query.
 *
 * geo-places is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-places:SearchText`. Requests and responses are raw distilled types (no
 * marshalling).
 *
 * @binding
 * @section Searching Places
 * Provide the `SearchTextHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoPlaces.SearchTextHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Search for a place by text
 * ```typescript
 * // init
 * const searchText = yield* AWS.GeoPlaces.SearchText();
 *
 * // runtime
 * const result = yield* searchText({
 *   QueryText: "Space Needle, Seattle",
 *   MaxResults: 5,
 * });
 * const first = result.ResultItems?.[0];
 * ```
 */
export interface SearchText extends Binding.Service<
  SearchText,
  "AWS.GeoPlaces.SearchText",
  () => Effect.Effect<
    (
      request: geoPlaces.SearchTextRequest,
    ) => Effect.Effect<geoPlaces.SearchTextResponse, geoPlaces.SearchTextError>
  >
> {}
export const SearchText = Binding.Service<SearchText>(
  "AWS.GeoPlaces.SearchText",
);
