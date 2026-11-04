import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Layer from "effect/Layer";
import { makeLakeFormationHttpBinding } from "./BindingHttp.ts";
import { SearchDatabasesByLFTags } from "./SearchDatabasesByLFTags.ts";

export const SearchDatabasesByLFTagsHttp = Layer.effect(
  SearchDatabasesByLFTags,
  makeLakeFormationHttpBinding({
    capability: "SearchDatabasesByLFTags",
    iamActions: ["lakeformation:SearchDatabasesByLFTags"],
    operation: lf.searchDatabasesByLFTags,
  }),
);
