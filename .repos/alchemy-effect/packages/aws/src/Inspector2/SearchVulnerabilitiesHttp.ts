import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { SearchVulnerabilities } from "./SearchVulnerabilities.ts";

export const SearchVulnerabilitiesHttp = Layer.effect(
  SearchVulnerabilities,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.SearchVulnerabilities",
    operation: inspector2.searchVulnerabilities,
    actions: ["inspector2:SearchVulnerabilities"],
  }),
);
