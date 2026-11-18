import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Layer from "effect/Layer";
import { makeGeoPlacesHttpBinding } from "./BindingHttp.ts";
import { Geocode } from "./Geocode.ts";

export const GeocodeHttp = Layer.effect(
  Geocode,
  makeGeoPlacesHttpBinding({
    capability: "Geocode",
    iamActions: ["geo-places:Geocode"],
    operation: geoPlaces.geocode,
  }),
);
