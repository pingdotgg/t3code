import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationPlaceIndexHttpBinding } from "./BindingHttp.ts";
import { SearchPlaceIndexForPosition } from "./SearchPlaceIndexForPosition.ts";

export const SearchPlaceIndexForPositionHttp = Layer.effect(
  SearchPlaceIndexForPosition,
  makeLocationPlaceIndexHttpBinding({
    tag: "AWS.Location.SearchPlaceIndexForPosition",
    operation: location.searchPlaceIndexForPosition,
    actions: ["geo:SearchPlaceIndexForPosition"],
  }),
);
