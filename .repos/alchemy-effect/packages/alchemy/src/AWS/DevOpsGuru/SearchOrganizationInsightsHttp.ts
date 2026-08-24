import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { SearchOrganizationInsights } from "./SearchOrganizationInsights.ts";

export const SearchOrganizationInsightsHttp = Layer.effect(
  SearchOrganizationInsights,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.SearchOrganizationInsights",
    operation: devopsguru.searchOrganizationInsights,
    actions: ["devops-guru:SearchOrganizationInsights"],
  }),
);
