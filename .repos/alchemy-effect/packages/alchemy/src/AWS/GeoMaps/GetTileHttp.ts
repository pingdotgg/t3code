import * as geoMaps from "@distilled.cloud/aws/geo-maps";
import * as Layer from "effect/Layer";
import { makeGeoMapsHttpBinding } from "./BindingHttp.ts";
import { GetTile } from "./GetTile.ts";

export const GetTileHttp = Layer.effect(
  GetTile,
  makeGeoMapsHttpBinding({
    capability: "GetTile",
    iamActions: ["geo-maps:GetTile"],
    operation: geoMaps.getTile,
  }),
);
