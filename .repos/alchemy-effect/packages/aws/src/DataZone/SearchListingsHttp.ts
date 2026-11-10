import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { SearchListings } from "./SearchListings.ts";

export const SearchListingsHttp = Layer.effect(
  SearchListings,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.SearchListings",
    operation: datazone.searchListings,
    actions: ["datazone:SearchListings"],
  }),
);
