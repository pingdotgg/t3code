import type * as geoMaps from "@distilled.cloud/aws/geo-maps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-maps:GetSprites` — fetch a map style's sprite
 * sheet (PNG) or sprite index (JSON) used to render map iconography.
 *
 * geo-maps is a standalone, pay-per-call Amazon Location API with no resource
 * to manage: the binding takes no arguments and grants the function
 * `geo-maps:GetSprites`. Requests and responses are raw distilled types; the
 * sprite payload is returned as `Blob` (`Uint8Array`).
 *
 * @binding
 * @section Fetching Sprites
 * Provide the `GetSpritesHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoMaps.GetSpritesHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Fetch the Standard style's sprite sheet
 * ```typescript
 * // init
 * const getSprites = yield* AWS.GeoMaps.GetSprites();
 *
 * // runtime — FileName follows `sprites(@2x)?.(png|json)`
 * const sprites = yield* getSprites({
 *   FileName: "sprites.png",
 *   Style: "Standard",
 *   ColorScheme: "Light",
 *   Variant: "Default",
 * });
 * const bytes = sprites.Blob; // Uint8Array | undefined (PNG or JSON)
 * ```
 */
export interface GetSprites extends Binding.Service<
  GetSprites,
  "AWS.GeoMaps.GetSprites",
  () => Effect.Effect<
    (
      request: geoMaps.GetSpritesRequest,
    ) => Effect.Effect<geoMaps.GetSpritesResponse, geoMaps.GetSpritesError>
  >
> {}
export const GetSprites = Binding.Service<GetSprites>("AWS.GeoMaps.GetSprites");
