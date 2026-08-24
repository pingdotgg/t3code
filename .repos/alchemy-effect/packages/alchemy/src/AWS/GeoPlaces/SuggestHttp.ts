import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Layer from "effect/Layer";
import { makeGeoPlacesHttpBinding } from "./BindingHttp.ts";
import { Suggest } from "./Suggest.ts";

export const SuggestHttp = Layer.effect(
  Suggest,
  makeGeoPlacesHttpBinding({
    capability: "Suggest",
    iamActions: ["geo-places:Suggest"],
    operation: geoPlaces.suggest,
  }),
);
