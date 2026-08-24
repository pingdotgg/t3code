import type * as geoPlaces from "@distilled.cloud/aws/geo-places";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-places:Autocomplete` — complete potential places
 * and addresses as the user types, based on partial input.
 *
 * geo-places is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-places:Autocomplete`. Requests and responses are raw distilled types
 * (no marshalling).
 *
 * @binding
 * @section Autocompleting Queries
 * Provide the `AutocompleteHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoPlaces.AutocompleteHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Autocomplete a partial address
 * ```typescript
 * // init
 * const autocomplete = yield* AWS.GeoPlaces.Autocomplete();
 *
 * // runtime
 * const result = yield* autocomplete({
 *   QueryText: "1600 Pennsylvania",
 *   MaxResults: 5,
 * });
 * const first = result.ResultItems?.[0]?.Title;
 * ```
 */
export interface Autocomplete extends Binding.Service<
  Autocomplete,
  "AWS.GeoPlaces.Autocomplete",
  () => Effect.Effect<
    (
      request: geoPlaces.AutocompleteRequest,
    ) => Effect.Effect<
      geoPlaces.AutocompleteResponse,
      geoPlaces.AutocompleteError
    >
  >
> {}
export const Autocomplete = Binding.Service<Autocomplete>(
  "AWS.GeoPlaces.Autocomplete",
);
