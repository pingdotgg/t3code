import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Layer from "effect/Layer";
import { makeGeoPlacesHttpBinding } from "./BindingHttp.ts";
import { ReverseGeocode } from "./ReverseGeocode.ts";

export const ReverseGeocodeHttp = Layer.effect(
  ReverseGeocode,
  makeGeoPlacesHttpBinding({
    capability: "ReverseGeocode",
    iamActions: ["geo-places:ReverseGeocode"],
    operation: geoPlaces.reverseGeocode,
  }),
);
