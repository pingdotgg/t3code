import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { SearchInsights } from "./SearchInsights.ts";

export const SearchInsightsHttp = Layer.effect(
  SearchInsights,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.SearchInsights",
    operation: devopsguru.searchInsights,
    actions: ["devops-guru:SearchInsights"],
  }),
);
