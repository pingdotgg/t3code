import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationPlaceIndexHttpBinding } from "./BindingHttp.ts";
import { SearchPlaceIndexForText } from "./SearchPlaceIndexForText.ts";

export const SearchPlaceIndexForTextHttp = Layer.effect(
  SearchPlaceIndexForText,
  makeLocationPlaceIndexHttpBinding({
    tag: "AWS.Location.SearchPlaceIndexForText",
    operation: location.searchPlaceIndexForText,
    actions: ["geo:SearchPlaceIndexForText"],
  }),
);
