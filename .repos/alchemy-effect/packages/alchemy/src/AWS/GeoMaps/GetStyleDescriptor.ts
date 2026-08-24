import type * as geoMaps from "@distilled.cloud/aws/geo-maps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `geo-maps:GetStyleDescriptor` — fetch the MapLibre
 * style descriptor (JSON) for a map style, optionally customized with
 * political view, terrain, traffic, and building options.
 *
 * geo-maps is a standalone, pay-per-call Amazon Location API with no resource
 * to manage: the binding takes no arguments and grants the function
 * `geo-maps:GetStyleDescriptor`. Requests and responses are raw distilled
 * types; the descriptor payload is returned as `Blob` (`Uint8Array` of JSON).
 *
 * @binding
 * @section Fetching Style Descriptors
 * Provide the `GetStyleDescriptorHttp` implementation layer on the Function
 * effect (`.pipe(Effect.provide(AWS.GeoMaps.GetStyleDescriptorHttp))`), bind
 * in the init phase, then call the client at runtime.
 *
 * @example Fetch the Standard style descriptor
 * ```typescript
 * // init
 * const getStyleDescriptor = yield* AWS.GeoMaps.GetStyleDescriptor();
 *
 * // runtime — Style is one of "Standard" | "Monochrome" | "Hybrid" | "Satellite"
 * const descriptor = yield* getStyleDescriptor({ Style: "Standard" });
 * const json = new TextDecoder().decode(descriptor.Blob); // MapLibre style JSON
 * ```
 */
export interface GetStyleDescriptor extends Binding.Service<
  GetStyleDescriptor,
  "AWS.GeoMaps.GetStyleDescriptor",
  () => Effect.Effect<
    (
      request: geoMaps.GetStyleDescriptorRequest,
    ) => Effect.Effect<
      geoMaps.GetStyleDescriptorResponse,
      geoMaps.GetStyleDescriptorError
    >
  >
> {}
export const GetStyleDescriptor = Binding.Service<GetStyleDescriptor>(
  "AWS.GeoMaps.GetStyleDescriptor",
);
