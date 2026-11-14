import * as geoMaps from "@distilled.cloud/aws/geo-maps";
import * as Layer from "effect/Layer";
import { makeGeoMapsHttpBinding } from "./BindingHttp.ts";
import { GetGlyphs } from "./GetGlyphs.ts";

export const GetGlyphsHttp = Layer.effect(
  GetGlyphs,
  makeGeoMapsHttpBinding({
    capability: "GetGlyphs",
    iamActions: ["geo-maps:GetGlyphs"],
    operation: geoMaps.getGlyphs,
  }),
);
