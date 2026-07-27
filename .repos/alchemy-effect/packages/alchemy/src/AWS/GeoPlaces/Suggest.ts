import type * as geoPlaces from "@distilled.cloud/aws/geo-places";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-places:Suggest` — suggest places and query
 * refinements for a free-form (possibly misspelled or partial) query,
 * ranked by relevance. Unlike Autocomplete, Suggest returns place
 * suggestions (with `PlaceId`s) and query suggestions, tuned for
 * point-of-interest discovery.
 *
 * geo-places is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: the binding takes no arguments and grants the function
 * `geo-places:Suggest`. Requests and responses are raw distilled types (no
 * marshalling).
 *
 * @binding
 * @section Suggesting Places
 * Provide the `SuggestHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoPlaces.SuggestHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Suggest places for a free-form query
 * ```typescript
 * // init
 * const suggest = yield* AWS.GeoPlaces.Suggest();
 *
 * // runtime
 * const result = yield* suggest({
 *   QueryText: "coffee",
 *   BiasPosition: [-122.3493, 47.6205], // [lng, lat]
 *   MaxResults: 5,
 * });
 * const first = result.ResultItems?.[0]?.Title;
 * ```
 */
export interface Suggest extends Binding.Service<
  Suggest,
  "AWS.GeoPlaces.Suggest",
  () => Effect.Effect<
    (
      request: geoPlaces.SuggestRequest,
    ) => Effect.Effect<geoPlaces.SuggestResponse, geoPlaces.SuggestError>
  >
> {}
export const Suggest = Binding.Service<Suggest>("AWS.GeoPlaces.Suggest");
