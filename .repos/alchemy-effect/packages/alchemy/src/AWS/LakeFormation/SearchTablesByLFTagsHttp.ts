import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { SearchTablesByLFTags } from "./SearchTablesByLFTags.ts";

export const SearchTablesByLFTagsHttp = Layer.effect(
  SearchTablesByLFTags,
  makeLakeFormationHttpBinding({
    capability: "SearchTablesByLFTags",
    iamActions: ["lakeformation:SearchTablesByLFTags"],
    operation: lf.searchTablesByLFTags,
  }),
);
