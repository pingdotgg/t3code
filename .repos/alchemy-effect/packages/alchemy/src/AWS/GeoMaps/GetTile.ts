import type * as geoMaps from "@distilled.cloud/aws/geo-maps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-maps:GetTile` — fetch a single map tile addressed
 * by tileset, zoom level, and X/Y grid coordinates.
 *
 * geo-maps is a standalone, pay-per-call Amazon Location API with no resource
 * to manage: the binding takes no arguments and grants the function
 * `geo-maps:GetTile`. Requests and responses are raw distilled types; the
 * tile payload is returned as `Blob` (`Uint8Array`).
 *
 * @binding
 * @section Fetching Map Tiles
 * Provide the `GetTileHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoMaps.GetTileHttp))`), bind in the init phase,
 * then call the client at runtime.
 *
 * @example Fetch a vector tile
 * ```typescript
 * // init
 * const getTile = yield* AWS.GeoMaps.GetTile();
 *
 * // runtime — Z/X/Y are string coordinates in the tile grid
 * const tile = yield* getTile({
 *   Tileset: "vector.basemap",
 *   Z: "0",
 *   X: "0",
 *   Y: "0",
 * });
 * const bytes = tile.Blob; // Uint8Array | undefined
 * ```
 */
export interface GetTile extends Binding.Service<
  GetTile,
  "AWS.GeoMaps.GetTile",
  () => Effect.Effect<
    (
      request: geoMaps.GetTileRequest,
    ) => Effect.Effect<geoMaps.GetTileResponse, geoMaps.GetTileError>
  >
> {}
export const GetTile = Binding.Service<GetTile>("AWS.GeoMaps.GetTile");
