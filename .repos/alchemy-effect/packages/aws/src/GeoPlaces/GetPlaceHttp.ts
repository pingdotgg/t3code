import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Layer from "effect/Layer";
import { makeGeoPlacesHttpBinding } from "./BindingHttp.ts";
import { GetPlace } from "./GetPlace.ts";

export const GetPlaceHttp = Layer.effect(
  GetPlace,
  makeGeoPlacesHttpBinding({
    capability: "GetPlace",
    iamActions: ["geo-places:GetPlace"],
    operation: geoPlaces.getPlace,
  }),
);
