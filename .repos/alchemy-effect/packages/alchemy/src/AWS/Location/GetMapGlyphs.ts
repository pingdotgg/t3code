import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Map as LocationMap } from "./Map.ts";

/**
 * `GetMapGlyphs` request with `MapName` injected from the bound
 * resource.
 */
export interface GetMapGlyphsRequest extends Omit<
  location.GetMapGlyphsRequest,
  "MapName"
> {}

/**
 * Retrieves a glyph range (font PBF) used to render map labels.
 *
 * Runtime binding for the `GetMapGlyphs` operation (IAM action
 * `geo:GetMapGlyphs`), scoped to one {@link LocationMap | Map}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetMapGlyphsHttp)`.
 *
 * @binding
 * @section Serving Map Assets
 * @example Serve Glyphs
 * ```typescript
 * const getGlyphs = yield* Location.GetMapGlyphs(map);
 *
 * const glyphs = yield* getGlyphs({
 *   FontStack: "Arial Regular",
 *   FontUnicodeRange: "0-255.pbf",
 * });
 * // glyphs.Blob → protobuf-encoded glyph bytes
 * ```
 */
export interface GetMapGlyphs extends Binding.Service<
  GetMapGlyphs,
  "AWS.Location.GetMapGlyphs",
  (
    map: LocationMap,
  ) => Effect.Effect<
    (
      request: GetMapGlyphsRequest,
    ) => Effect.Effect<
      location.GetMapGlyphsResponse,
      location.GetMapGlyphsError
    >
  >
> {}
export const GetMapGlyphs = Binding.Service<GetMapGlyphs>(
  "AWS.Location.GetMapGlyphs",
);
