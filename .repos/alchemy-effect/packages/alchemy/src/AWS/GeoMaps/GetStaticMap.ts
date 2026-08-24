import type * as geoMaps from "@distilled.cloud/aws/geo-maps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-maps:GetStaticMap` — render a static map image
 * with customizable size, center, zoom, and overlays.
 *
 * geo-maps is a standalone, pay-per-call Amazon Location API with no resource
 * to manage: the binding takes no arguments and grants the function
 * `geo-maps:GetStaticMap`. Requests and responses are raw distilled types;
 * the image payload is returned as `Blob` (`Uint8Array`).
 *
 * @binding
 * @section Rendering Static Maps
 * Provide the `GetStaticMapHttp` implementation layer on the Function effect
 * (`.pipe(Effect.provide(AWS.GeoMaps.GetStaticMapHttp))`), bind in the init
 * phase, then call the client at runtime.
 *
 * @example Render a static map centered on a point
 * ```typescript
 * // init
 * const getStaticMap = yield* AWS.GeoMaps.GetStaticMap();
 *
 * // runtime — Center is "longitude,latitude"; FileName must be "map" or "map@2x"
 * const image = yield* getStaticMap({
 *   FileName: "map",
 *   Center: "-122.3493,47.6205",
 *   Zoom: 12,
 *   Width: 400,
 *   Height: 300,
 * });
 * const bytes = image.Blob; // Uint8Array | undefined (PNG)
 * ```
 */
export interface GetStaticMap extends Binding.Service<
  GetStaticMap,
  "AWS.GeoMaps.GetStaticMap",
  () => Effect.Effect<
    (
      request: geoMaps.GetStaticMapRequest,
    ) => Effect.Effect<geoMaps.GetStaticMapResponse, geoMaps.GetStaticMapError>
  >
> {}
export const GetStaticMap = Binding.Service<GetStaticMap>(
  "AWS.GeoMaps.GetStaticMap",
);
