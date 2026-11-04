import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Layer from "effect/Layer";
import { Autocomplete } from "./Autocomplete.ts";
import { makeGeoPlacesHttpBinding } from "./BindingHttp.ts";

export const AutocompleteHttp = Layer.effect(
  Autocomplete,
  makeGeoPlacesHttpBinding({
    capability: "Autocomplete",
    iamActions: ["geo-places:Autocomplete"],
    operation: geoPlaces.autocomplete,
  }),
);
