import * as geoPlaces from "@distilled.cloud/aws/geo-places";
import * as Layer from "effect/Layer";
import { makeGeoPlacesHttpBinding } from "./BindingHttp.ts";
import { SearchText } from "./SearchText.ts";

export const SearchTextHttp = Layer.effect(
  SearchText,
  makeGeoPlacesHttpBinding({
    capability: "SearchText",
    iamActions: ["geo-places:SearchText"],
    operation: geoPlaces.searchText,
  }),
);
