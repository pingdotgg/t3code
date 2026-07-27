import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlaceIndex } from "./PlaceIndex.ts";

/**
 * `GetPlace` request with `IndexName` injected from the bound
 * resource.
 */
export interface GetPlaceRequest extends Omit<
  location.GetPlaceRequest,
  "IndexName"
> {}

/**
 * Fetches the full details of a place by the `PlaceId` returned from a search.
 *
 * Runtime binding for the `GetPlace` operation (IAM action
 * `geo:GetPlace`), scoped to one {@link PlaceIndex}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetPlaceHttp)`.
 *
 * @binding
 * @section Searching Places
 * @example Fetch Place Details
 * ```typescript
 * const getPlace = yield* Location.GetPlace(index);
 *
 * const place = yield* getPlace({ PlaceId: placeId });
 * // place.Place.Label, place.Place.Geometry.Point
 * ```
 */
export interface GetPlace extends Binding.Service<
  GetPlace,
  "AWS.Location.GetPlace",
  (
    index: PlaceIndex,
  ) => Effect.Effect<
    (
      request: GetPlaceRequest,
    ) => Effect.Effect<location.GetPlaceResponse, location.GetPlaceError>
  >
> {}
export const GetPlace = Binding.Service<GetPlace>("AWS.Location.GetPlace");
