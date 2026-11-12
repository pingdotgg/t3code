import * as RE2 from "@distilled.cloud/aws/resource-explorer-2";
import * as Layer from "effect/Layer";
import { makeResourceExplorerViewHttpBinding } from "./BindingHttp.ts";
import { Search } from "./Search.ts";

export const SearchHttp = Layer.effect(
  Search,
  makeResourceExplorerViewHttpBinding({
    tag: "AWS.ResourceExplorer.Search",
    operation: RE2.search,
    actions: ["resource-explorer-2:Search"],
  }),
);
