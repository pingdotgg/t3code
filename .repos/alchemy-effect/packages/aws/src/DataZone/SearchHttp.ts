import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { Search } from "./Search.ts";

export const SearchHttp = Layer.effect(
  Search,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.Search",
    operation: datazone.search,
    actions: ["datazone:Search"],
  }),
);
