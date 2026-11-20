import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { SearchTypes } from "./SearchTypes.ts";

export const SearchTypesHttp = Layer.effect(
  SearchTypes,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.SearchTypes",
    operation: datazone.searchTypes,
    actions: ["datazone:SearchTypes"],
  }),
);
