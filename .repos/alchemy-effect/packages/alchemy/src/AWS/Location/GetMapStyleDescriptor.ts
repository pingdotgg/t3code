import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Map as LocationMap } from "./Map.ts";

/**
 * `GetMapStyleDescriptor` request with `MapName` injected from the bound
 * resource.
 */
export interface GetMapStyleDescriptorRequest extends Omit<
  location.GetMapStyleDescriptorRequest,
  "MapName"
> {}

/**
 * Retrieves the map's style descriptor document (the MapLibre/Mapbox GL style JSON).
 *
 * Runtime binding for the `GetMapStyleDescriptor` operation (IAM action
 * `geo:GetMapStyleDescriptor`), scoped to one {@link LocationMap | Map}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetMapStyleDescriptorHttp)`.
 *
 * @binding
 * @section Serving Map Assets
 * @example Serve the Style Descriptor
 * ```typescript
 * const getStyle = yield* Location.GetMapStyleDescriptor(map);
 *
 * const style = yield* getStyle();
 * // style.Blob → style JSON bytes, style.ContentType → "application/json"
 * ```
 */
export interface GetMapStyleDescriptor extends Binding.Service<
  GetMapStyleDescriptor,
  "AWS.Location.GetMapStyleDescriptor",
  (
    map: LocationMap,
  ) => Effect.Effect<
    (
      request?: GetMapStyleDescriptorRequest,
    ) => Effect.Effect<
      location.GetMapStyleDescriptorResponse,
      location.GetMapStyleDescriptorError
    >
  >
> {}
export const GetMapStyleDescriptor = Binding.Service<GetMapStyleDescriptor>(
  "AWS.Location.GetMapStyleDescriptor",
);
