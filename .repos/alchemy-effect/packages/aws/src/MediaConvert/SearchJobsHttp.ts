import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { SearchJobs } from "./SearchJobs.ts";

export const SearchJobsHttp = Layer.effect(
  SearchJobs,
  makeMediaConvertHttpBinding({
    capability: "SearchJobs",
    iamActions: ["mediaconvert:SearchJobs"],
    operation: mediaconvert.searchJobs,
  }),
);
