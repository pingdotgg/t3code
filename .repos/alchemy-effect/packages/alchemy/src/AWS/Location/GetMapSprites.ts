import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Map as LocationMap } from "./Map.ts";

/**
 * `GetMapSprites` request with `MapName` injected from the bound
 * resource.
 */
export interface GetMapSpritesRequest extends Omit<
  location.GetMapSpritesRequest,
  "MapName"
> {}

/**
 * Retrieves the map's sprite sheet (PNG) or sprite index (JSON) used to render icons.
 *
 * Runtime binding for the `GetMapSprites` operation (IAM action
 * `geo:GetMapSprites`), scoped to one {@link LocationMap | Map}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetMapSpritesHttp)`.
 *
 * @binding
 * @section Serving Map Assets
 * @example Serve the Sprite Index
 * ```typescript
 * const getSprites = yield* Location.GetMapSprites(map);
 *
 * const sprites = yield* getSprites({ FileName: "sprites.json" });
 * // sprites.Blob → sprite index JSON bytes
 * ```
 */
export interface GetMapSprites extends Binding.Service<
  GetMapSprites,
  "AWS.Location.GetMapSprites",
  (
    map: LocationMap,
  ) => Effect.Effect<
    (
      request: GetMapSpritesRequest,
    ) => Effect.Effect<
      location.GetMapSpritesResponse,
      location.GetMapSpritesError
    >
  >
> {}
export const GetMapSprites = Binding.Service<GetMapSprites>(
  "AWS.Location.GetMapSprites",
);
