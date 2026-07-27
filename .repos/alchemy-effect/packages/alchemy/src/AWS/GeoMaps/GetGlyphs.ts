import type * as geoMaps from "@distilled.cloud/aws/geo-maps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-maps:GetGlyphs` — fetch a glyph (font) PBF range
 * used to render map labels for a font stack.
 *
 * geo-maps is a standalone, pay-per-call Amazon Location API with no resource
 * to manage: the binding takes no arguments and grants the function
 * `geo-maps:GetGlyphs`. Requests and responses are raw distilled types; the
 * glyph payload is returned as `Blob` (`Uint8Array`).
 *
 * @binding
 * @section Fetching Glyphs
 * Provide the `GetGlyphsHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoMaps.GetGlyphsHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Fetch a glyph range for a font stack
 * ```typescript
 * // init
 * const getGlyphs = yield* AWS.GeoMaps.GetGlyphs();
 *
 * // runtime — FontUnicodeRange is a 256-glyph PBF page like "0-255.pbf"
 * const glyphs = yield* getGlyphs({
 *   FontStack: "Amazon Ember Regular",
 *   FontUnicodeRange: "0-255.pbf",
 * });
 * const bytes = glyphs.Blob; // Uint8Array | undefined (PBF)
 * ```
 */
export interface GetGlyphs extends Binding.Service<
  GetGlyphs,
  "AWS.GeoMaps.GetGlyphs",
  () => Effect.Effect<
    (
      request: geoMaps.GetGlyphsRequest,
    ) => Effect.Effect<geoMaps.GetGlyphsResponse, geoMaps.GetGlyphsError>
  >
> {}
export const GetGlyphs = Binding.Service<GetGlyphs>("AWS.GeoMaps.GetGlyphs");
