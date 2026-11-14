import * as location from "@distilled.cloud/aws/location";
import * as Layer from "effect/Layer";
import { makeLocationPlaceIndexHttpBinding } from "./BindingHttp.ts";
import { SearchPlaceIndexForSuggestions } from "./SearchPlaceIndexForSuggestions.ts";

export const SearchPlaceIndexForSuggestionsHttp = Layer.effect(
  SearchPlaceIndexForSuggestions,
  makeLocationPlaceIndexHttpBinding({
    tag: "AWS.Location.SearchPlaceIndexForSuggestions",
    operation: location.searchPlaceIndexForSuggestions,
    actions: ["geo:SearchPlaceIndexForSuggestions"],
  }),
);
