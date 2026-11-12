import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { SearchResources } from "./SearchResources.ts";

export const SearchResourcesHttp = Layer.effect(
  SearchResources,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.SearchResources",
    operation: macie2.searchResources,
    actions: ["macie2:SearchResources"],
  }),
);
