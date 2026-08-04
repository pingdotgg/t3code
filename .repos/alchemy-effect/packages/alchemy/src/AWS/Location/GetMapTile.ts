import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Map as LocationMap } from "./Map.ts";

/**
 * `GetMapTile` request with `MapName` injected from the bound
 * resource.
 */
export interface GetMapTileRequest extends Omit<
  location.GetMapTileRequest,
  "MapName"
> {}

/**
 * Retrieves a single map tile (vector or raster) addressed by zoom/x/y.
 *
 * Runtime binding for the `GetMapTile` operation (IAM action
 * `geo:GetMapTile`), scoped to one {@link LocationMap | Map}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetMapTileHttp)`.
 *
 * @binding
 * @section Serving Map Assets
 * @example Serve a Tile
 * ```typescript
 * const getTile = yield* Location.GetMapTile(map);
 *
 * const tile = yield* getTile({ Z: "0", X: "0", Y: "0" });
 * // tile.Blob → tile bytes, tile.ContentType → e.g. "application/vnd.mapbox-vector-tile"
 * ```
 */
export interface GetMapTile extends Binding.Service<
  GetMapTile,
  "AWS.Location.GetMapTile",
  (
    map: LocationMap,
  ) => Effect.Effect<
    (
      request: GetMapTileRequest,
    ) => Effect.Effect<location.GetMapTileResponse, location.GetMapTileError>
  >
> {}
export const GetMapTile = Binding.Service<GetMapTile>(
  "AWS.Location.GetMapTile",
);
